import './logging.js';
import log4js from 'log4js';
import express from "express";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { InitializeRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import server from './mcpServer.ts';

const l = log4js.getLogger();

const app = express();
app.use(express.json());
app.use((req, res, next) => {
    l.debug(`> ${req.method} ${req.originalUrl}`);
    l.debug(req.body);
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', '*');
    return next();
});

// Map to store transports by session ID
const transports = {};

// Handle POST requests for client-to-server communication
app.post('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    let transport;

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
            enableJsonResponse: true,
            onsessioninitialized: (sessionId) => {
                l.debug(`transport.onsessioninitialized sessionId=${sessionId}`);
                transports[sessionId] = transport;
            }
        });

        await server.connect(transport);
    } else {
        l.debug(`Invalid request, no sessionId`);
        res.status(400).json({
            jsonrpc: '2.0',
            error: {
                code: -32000,
                message: 'Bad Request: No valid session ID provided',
            },
            id: null,
        });
        return;
    }

    await transport.handleRequest(req, res, req.body);
});

function isInitializeRequest(body) {
    const isInitial = (data) => {
        const result = InitializeRequestSchema.safeParse(data)
        return result.success
    }
    if (Array.isArray(body)) {
        return body.some(request => isInitial(request))
    }
    return isInitial(body)
}

// Handle GET requests for server-to-client notifications via SSE
app.get('/mcp', (req, res) => {
    res.status(405).set('Allow', 'POST').send('Method Not Allowed');
});

// Handle DELETE requests for session termination
app.delete('/mcp', (req, res) => {
    res.status(405).set('Allow', 'POST').send('Method Not Allowed');
});

const port = 3000;
app.listen(port, () => {
    l.debug(`Listening on http://localhost:${port}`);
});

// import serverlessExpress from '@codegenie/serverless-express';
// export const handler = serverlessExpress({ app });
