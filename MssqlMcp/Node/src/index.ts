#!/usr/bin/env node

// External imports
import * as dotenv from "dotenv";
import sql from "mssql";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// Internal imports
import { UpdateDataTool } from "./tools/UpdateDataTool.js";
import { InsertDataTool } from "./tools/InsertDataTool.js";
import { ReadDataTool } from "./tools/ReadDataTool.js";
import { CreateTableTool } from "./tools/CreateTableTool.js";
import { CreateIndexTool } from "./tools/CreateIndexTool.js";
import { ListTableTool } from "./tools/ListTableTool.js";
import { DropTableTool } from "./tools/DropTableTool.js";
import { AzureCliCredential, InteractiveBrowserCredential } from "@azure/identity";
import { DescribeTableTool } from "./tools/DescribeTableTool.js";
import { ExportDataTool } from "./tools/ExportDataTool.js";
import { ExecutePythonTool } from "./tools/ExecutePythonTool.js";

// MSSQL Database connection configuration

// Type for authentication result
type AuthResult = {
  type: 'azure-ad' | 'sql-auth';
  config: sql.config;
  token: string | null;
  expiresOn: Date | null;
};

// Globals for connection and token reuse
let globalSqlPool: sql.ConnectionPool | null = null;
let globalAccessToken: string | null = null;
let globalTokenExpiresOn: Date | null = null;
let globalAuthType: 'azure-ad' | 'sql-auth' | null = null;

// Helper functions for configuration
function getTrustCertificate(): boolean {
  return process.env.TRUST_SERVER_CERTIFICATE?.toLowerCase() === 'true';
}

function getConnectionTimeout(): number {
  const timeout = process.env.CONNECTION_TIMEOUT ? parseInt(process.env.CONNECTION_TIMEOUT, 10) : 30;
  return timeout * 1000; // convert seconds to milliseconds
}

// Authentication helper functions
async function tryAzureCliAuth(): Promise<AuthResult | null> {
  try {
    const credential = new AzureCliCredential();
    const accessToken = await credential.getToken('https://database.windows.net/.default');
    return {
      type: 'azure-ad',
      config: {
        server: process.env.SERVER_NAME!,
        database: process.env.DATABASE_NAME!,
        options: {
          encrypt: true,
          trustServerCertificate: getTrustCertificate()
        },
        authentication: {
          type: 'azure-active-directory-access-token',
          options: {
            token: accessToken?.token!,
          },
        },
        connectionTimeout: getConnectionTimeout()
      },
      token: accessToken?.token!,
      expiresOn: accessToken?.expiresOnTimestamp ? new Date(accessToken.expiresOnTimestamp) : new Date(Date.now() + 30 * 60 * 1000)
    };
  } catch (error: any) {
    console.error('[Auth] Azure CLI failed:', error.message);
    return null;
  }
}

async function trySqlAuth(): Promise<AuthResult | null> {
  const username = process.env.SQL_USERNAME;
  const password = process.env.SQL_PASSWORD;

  if (!username || !password) {
    console.error('[Auth] SQL auth skipped: SQL_USERNAME and SQL_PASSWORD not provided');
    return null;
  }

  try {
    return {
      type: 'sql-auth',
      config: {
        server: process.env.SERVER_NAME!,
        database: process.env.DATABASE_NAME!,
        user: username,
        password: password,
        options: {
          encrypt: true,
          trustServerCertificate: getTrustCertificate()
        },
        connectionTimeout: getConnectionTimeout()
      },
      token: null,
      expiresOn: null
    };
  } catch (error: any) {
    console.error('[Auth] SQL auth failed:', error.message);
    return null;
  }
}

async function tryInteractiveBrowserAuth(): Promise<AuthResult | null> {
  try {
    const credential = new InteractiveBrowserCredential({});
    const accessToken = await credential.getToken('https://database.windows.net/.default');
    return {
      type: 'azure-ad',
      config: {
        server: process.env.SERVER_NAME!,
        database: process.env.DATABASE_NAME!,
        options: {
          encrypt: true,
          trustServerCertificate: getTrustCertificate()
        },
        authentication: {
          type: 'azure-active-directory-access-token',
          options: {
            token: accessToken?.token!,
          },
        },
        connectionTimeout: getConnectionTimeout()
      },
      token: accessToken?.token!,
      expiresOn: accessToken?.expiresOnTimestamp ? new Date(accessToken.expiresOnTimestamp) : new Date(Date.now() + 30 * 60 * 1000)
    };
  } catch (error: any) {
    console.error('[Auth] Interactive browser failed:', error.message);
    return null;
  }
}

async function tryAuthenticationChain(): Promise<AuthResult> {
  // Try Azure CLI
  console.error('[Auth] Trying Azure CLI authentication...');
  let result = await tryAzureCliAuth();
  if (result) {
    console.error('[Auth] ✓ Azure CLI authentication successful');
    return result;
  }

  // Try SQL Auth
  console.error('[Auth] Trying SQL authentication...');
  result = await trySqlAuth();
  if (result) {
    console.error('[Auth] ✓ SQL authentication successful');
    return result;
  }

  // Try Interactive Browser (last resort)
  console.error('[Auth] Trying interactive browser authentication...');
  result = await tryInteractiveBrowserAuth();
  if (result) {
    console.error('[Auth] ✓ Interactive browser authentication successful');
    return result;
  }

  throw new Error('All authentication methods failed. Please provide either:\n  - Azure CLI login (run \'az login\')\n  - SQL credentials via SQL_USERNAME and SQL_PASSWORD environment variables');
}

async function authenticateWith(method: string): Promise<AuthResult> {
  switch (method) {
    case 'azure-cli':
      const azureResult = await tryAzureCliAuth();
      if (azureResult) return azureResult;
      throw new Error('Azure CLI authentication failed');

    case 'sql-auth':
      const sqlResult = await trySqlAuth();
      if (sqlResult) return sqlResult;
      throw new Error('SQL authentication failed');

    case 'interactive':
      const interactiveResult = await tryInteractiveBrowserAuth();
      if (interactiveResult) return interactiveResult;
      throw new Error('Interactive browser authentication failed');

    default:
      throw new Error(`Unknown authentication method: ${method}`);
  }
}

// Function to create SQL config with authentication fallback
export async function createSqlConfig(): Promise<{ config: sql.config, token: string | null, expiresOn: Date | null }> {
  const authMethod = process.env.AUTH_METHOD || 'auto';

  let result: AuthResult;
  if (authMethod === 'auto') {
    result = await tryAuthenticationChain();
  } else {
    result = await authenticateWith(authMethod);
  }

  return {
    config: result.config,
    token: result.token,
    expiresOn: result.expiresOn
  };
}

const updateDataTool = new UpdateDataTool();
const insertDataTool = new InsertDataTool();
const readDataTool = new ReadDataTool();
const createTableTool = new CreateTableTool();
const createIndexTool = new CreateIndexTool();
const listTableTool = new ListTableTool();
const dropTableTool = new DropTableTool();
const describeTableTool = new DescribeTableTool();
const exportDataTool = new ExportDataTool();
const executePythonTool = new ExecutePythonTool();

const server = new Server(
  {
    name: "mssql-mcp-server",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// Force read-only mode - no write operations exposed to agents
const isReadOnly = true;

// Request handlers

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: isReadOnly
    ? [listTableTool, readDataTool, describeTableTool, exportDataTool, executePythonTool] // execute_python is safe (SELECT only)
    : [insertDataTool, readDataTool, describeTableTool, updateDataTool, createTableTool, createIndexTool, dropTableTool, listTableTool, exportDataTool, executePythonTool],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    let result;
    switch (name) {
      case insertDataTool.name:
        result = await insertDataTool.run(args);
        break;
      case readDataTool.name:
        result = await readDataTool.run(args);
        break;
      case updateDataTool.name:
        result = await updateDataTool.run(args);
        break;
      case createTableTool.name:
        result = await createTableTool.run(args);
        break;
      case createIndexTool.name:
        result = await createIndexTool.run(args);
        break;
      case listTableTool.name:
        result = await listTableTool.run(args);
        break;
      case dropTableTool.name:
        result = await dropTableTool.run(args);
        break;
      case describeTableTool.name:
        if (!args || typeof args.tableName !== "string") {
          return {
            content: [{ type: "text", text: `Missing or invalid 'tableName' argument for describe_table tool.` }],
            isError: true,
          };
        }
        result = await describeTableTool.run(args as { tableName: string });
        break;
      case exportDataTool.name:
        result = await exportDataTool.run(args);
        break;
      case executePythonTool.name:
        result = await executePythonTool.run(args);
        break;
      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error occurred: ${error}` }],
      isError: true,
    };
  }
});

// Server startup
async function runServer() {
  try {
    const transport = new StdioServerTransport();
    await server.connect(transport);
  } catch (error) {
    console.error("Fatal error running server:", error);
    process.exit(1);
  }
}

runServer().catch((error) => {
  console.error("Fatal error running server:", error);
  process.exit(1);
});

// Connect to SQL only when handling a request

async function ensureSqlConnection() {
  // If using SQL auth, tokens don't expire - just check if pool is connected
  if (globalAuthType === 'sql-auth') {
    if (globalSqlPool && globalSqlPool.connected) {
      return; // SQL auth doesn't have token expiration
    }
  } else {
    // Azure AD token expiration check
    if (
      globalSqlPool &&
      globalSqlPool.connected &&
      globalAccessToken &&
      globalTokenExpiresOn &&
      globalTokenExpiresOn > new Date(Date.now() + 2 * 60 * 1000) // 2 min buffer
    ) {
      return;
    }
  }

  // Otherwise, get a new config and reconnect
  const { config, token, expiresOn } = await createSqlConfig();
  globalAccessToken = token;
  globalTokenExpiresOn = expiresOn;

  // Determine auth type from the result
  globalAuthType = token ? 'azure-ad' : 'sql-auth';

  // Close old pool if exists
  if (globalSqlPool && globalSqlPool.connected) {
    await globalSqlPool.close();
  }

  globalSqlPool = await sql.connect(config);
}

// Patch all tool handlers to ensure SQL connection before running
function wrapToolRun(tool: { run: (...args: any[]) => Promise<any> }) {
  const originalRun = tool.run.bind(tool);
  tool.run = async function (...args: any[]) {
    await ensureSqlConnection();
    return originalRun(...args);
  };
}

[insertDataTool, readDataTool, updateDataTool, createTableTool, createIndexTool, dropTableTool, listTableTool, describeTableTool, exportDataTool, executePythonTool].forEach(wrapToolRun);