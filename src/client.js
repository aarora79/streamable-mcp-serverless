import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const ENDPOINT_URL = process.env.SIMPLE_MCP_SERVER_ENDPOINT;
console.log(`Connecting ENDPOINT_URL=${ENDPOINT_URL}`);

const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT_URL));

const client = new Client({
    name: "node-client",
    version: "0.0.1"
})

await client.connect(transport);
const tools = await client.listTools();
console.log(`listTools response: `, tools);

const result = await client.callTool({
    name: "ping"
});
console.log(`callTool:ping response: `, result);

await client.close();
