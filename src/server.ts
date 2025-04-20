import './logging.js';
import log4js from 'log4js';
import express from "express";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { InitializeRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import mcpServer from './mcpServer.js'; // Corrected import extension

const l = log4js.getLogger();

const app = express();
app.use(express.json());
app.use((req, res, next) => {
    l.debug(`> ${req.method} ${req.originalUrl}`);
    l.debug('Request body:', req.body);
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', '*');
    // Add required headers based on previous versions
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
    res.set('Access-Control-Allow-Credentials', 'true');
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    return next();
});

// Map to store transports by session ID
interface TransportMap { // Define the type for clarity
    [key: string]: StreamableHTTPServerTransport;
}
const transports: TransportMap = {};

// Handle POST requests for client-to-server communication
app.post('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string; // Type assertion
    let transport: StreamableHTTPServerTransport; // Type annotation

    if (sessionId && transports[sessionId]) {
        l.debug(`found existing transport for sessionId=${sessionId}`);
        transport = transports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
        l.debug(`creating new transport`);
        transport = new StreamableHTTPServerTransport({
            //sessionIdGenerator: () => undefined,
            // ^ this should be used for fully sessionless connections,
            // but there's currently a bug preventing it. Waiting for next
            // SDK release to be fixed. In the meanwhile, let's use sessions. 
            
            sessionIdGenerator: () => randomUUID(),
            enableJsonResponse: true, // Keep as true from user's code
            onsessioninitialized: (newSessionId: string) => { // Type annotation
                l.debug(`transport.onsessioninitialized sessionId=${newSessionId}`);
                transports[newSessionId] = transport; // Use the correct newSessionId
            }
        });

        await mcpServer.connect(transport);
    } else {
        // Handle cases like missing session ID *after* initialization attempt
        l.debug(`Invalid request: No session ID provided or invalid request type.`); 
        res.status(400).json({
            jsonrpc: '2.0',
            error: {
                code: -32000,
                // Clarify error based on logic
                message: 'Bad Request: No valid session ID provided or not an initialize request',
            },
            id: req.body?.id ?? null, // Try to return request ID if available
        });
        return;
    }

    // Pass the already parsed body (by express.json)
    await transport.handleRequest(req, res, req.body); 
});

// Add type annotation for body parameter
function isInitializeRequest(body: any): boolean {
    // Add type annotation for data parameter
    const isInitial = (data: any): boolean => {
        // Check if data is actually an object before parsing
        if (typeof data !== 'object' || data === null) return false;
        const result = InitializeRequestSchema.safeParse(data);
        if (!result.success) {
             l.warn('InitializeRequestSchema parse failed:', result.error?.format());
        }
        return result.success;
    };
    if (Array.isArray(body)) {
        return body.some(request => isInitial(request));
    }
    return isInitial(body);
}

// Handle GET requests (Blocked as per user code)
app.get('/mcp', (req, res) => {
    l.warn('GET /mcp called but not implemented in this version.');
    res.status(405).set('Allow', 'POST, DELETE').send('Method Not Allowed');
});

// Handle DELETE requests for session termination
// Keep simplified version from user code for now
app.delete('/mcp', (req, res) => {
    // Note: This doesn't actually delete the session state in this version
    l.warn('DELETE /mcp called but session cleanup not fully implemented here.');
    res.status(405).set('Allow', 'POST').send('Method Not Allowed'); 
});

// --- Remove local app.listen block --- 
// const port = 3000;
// app.listen(port, () => {
//     l.debug(`Listening on http://localhost:${port}`);
// });

// --- Add back serverless-express --- 
import serverlessExpress from '@codegenie/serverless-express';
export const handler = serverlessExpress({ app });
