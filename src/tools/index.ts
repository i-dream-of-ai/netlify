// coding context
// focus tools on domain + focused operations
// tool domains:
//  [] site (includes builds, domains, forms, env vars, settings,)
//    [] builds - why did it fail
//    [] domains
//    [x] forms
//    [x] env vars
//    [x] access controls
//    [] settings
//  [] deploy
//    [x] build + deploy
//    [] rollback/deploy selection
//  [x] user-and-team
//    [x] user
//    [x] team
//    [] team env vars
//  [] sites aggregate operations
//  [x] extensions - install and link - not configuration
//  [] database
//
// return errors when missing data and how the agent can get the data


import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { userDomainTools } from './user-tools/index.js';
import { deployDomainTools } from './deploy-tools/index.js';
import { teamDomainTools } from './team-tools/index.js';
import { projectDomainTools } from './project-tools/index.js';
import { extensionDomainTools } from './extension-tools/index.js';
import { checkCompatibility } from '../utils/compatibility.js';
import { getNetlifyAccessToken, NetlifyUnauthError } from '../utils/api-networking.js';
import { appendToLog } from '../utils/logging.js';
import { z } from 'zod';
import type { DomainTool } from './types.js';

const listOfDomainTools = [userDomainTools, deployDomainTools, teamDomainTools, projectDomainTools, extensionDomainTools];

export const bindTools = async (server: McpServer, remoteMCPRequest?: Request) => {

  const isRemoteMCP = !!remoteMCPRequest;
  const toSelectorSchema = (domainTool: DomainTool<z.ZodType<any>>) => {
    return z.object({
      // domain: z.literal(domainTool.domain),
      operation: z.literal(domainTool.operation),
      params: domainTool.inputSchema,

      llmModelName: z.string().optional(),
      aiAgentName: z.string().optional()
    });
  }

  listOfDomainTools.forEach(domainTools => {
    
    const domain = domainTools[0].domain;
    const filteredDomainTools = domainTools.filter(tool => {
      if(isRemoteMCP && tool.omitFromRemoteMCP) {
        return false;
      }
      if(!isRemoteMCP && tool.omitFromLocalMCP) {
        return false;
      }
      return true;
    });
    const toolOperations = filteredDomainTools.map(tool => tool.operation);

    // join the input schemas of all domain tools into a raw array with
    // to give the llm the ability to select.
    const paramsSchema = {
      // @ts-ignore
      selectSchema: filteredDomainTools.length > 1 ? z.union(filteredDomainTools.map(tool => toSelectorSchema(tool))) : toSelectorSchema(filteredDomainTools[0])
    };

    const toolName = `netlify-${domain}-services`;
    const toolDescription = `Select and run one of the following Netlify operations ${toolOperations.join(', ')}`;
    server.tool(toolName, toolDescription, paramsSchema, async (...args) => {
      checkCompatibility();

      try {

        await getNetlifyAccessToken(remoteMCPRequest);
      } catch (error: NetlifyUnauthError | any) {

        // rethrow error to the top level handler to catch
        // so we can update the fn request to return a proper
        // server response instead of a tool response
        if (error instanceof NetlifyUnauthError && remoteMCPRequest) {
          throw new NetlifyUnauthError();
        }

        return {
          content: [{ type: "text", text: error?.message || 'Failed to get Netlify token' }],
          isError: true
        };
      }

      appendToLog(`${toolName} operation: ${JSON.stringify(args)}`);

      const selectedSchema = args[0]?.selectSchema;

      if (!selectedSchema) {
        return {
          content: [{ type: "text", text: 'Failed to select a valid operation. Retry the MCP operation but select the operation and provide the right inputs.' }]
        }
      }

      const operation = selectedSchema.operation;

      const subtool = filteredDomainTools.find(subtool => subtool.operation === operation);

      if (!subtool) {
        return {
          content: [{ type: "text", text: 'Agent called the wrong MCP tool for this operation.' }]
        }
      }

      const result = await subtool.cb(selectedSchema.params, {request: remoteMCPRequest, isRemoteMCP});

      appendToLog(`${domain} operation result: ${JSON.stringify(result)}`);

      return {
        content: [{ type: "text", text: JSON.stringify(result) }]
      }
    });
  });
};

