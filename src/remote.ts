#!/usr/bin/env node
/**
 * Remote HTTP Server Entry Point for Railway Deployment
 *
 * This provides an HTTP transport for the Todoist MCP server,
 * enabling remote access via the Streamable HTTP protocol.
 */
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import dotenv from 'dotenv'
import type { NextFunction, Request, Response } from 'express'
import { getMcpServer } from './mcp-server.js'

dotenv.config()

const PORT = Number(process.env.PORT ?? 8000)
const VALID_API_KEYS = (process.env.VALID_API_KEYS ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)

interface AuthResult {
    ok: true
}

interface AuthError {
    ok: false
    status: number
    error: string
}

function authenticateRequest(apiKey: string | undefined): AuthResult | AuthError {
    if (VALID_API_KEYS.length === 0) {
        return { ok: false, status: 500, error: 'VALID_API_KEYS not configured on server' }
    }
    if (!apiKey) {
        return {
            ok: false,
            status: 401,
            error: 'API key required. Add ?apiKey=YOUR_KEY to the URL',
        }
    }
    if (!VALID_API_KEYS.includes(apiKey)) {
        return { ok: false, status: 401, error: 'Invalid API key' }
    }
    return { ok: true }
}

// Create Express app - disable DNS rebinding protection for Railway (binding to 0.0.0.0)
const app = createMcpExpressApp({ host: '0.0.0.0' })

// CORS middleware for remote MCP access
app.use((req: Request, res: Response, next: NextFunction) => {
    res.header('Access-Control-Allow-Origin', '*')
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
    res.header('Access-Control-Allow-Headers', '*')
    res.header('Access-Control-Expose-Headers', 'Mcp-Session-Id, Content-Type')
    if (req.method === 'OPTIONS') {
        res.status(204).end()
        return
    }
    next()
})

// Main MCP endpoint - stateless mode (new server per request)
app.post('/mcp', async (req: Request, res: Response) => {
    const apiKey = typeof req.query.apiKey === 'string' ? req.query.apiKey : undefined
    const auth = authenticateRequest(apiKey)

    if (!auth.ok) {
        res.status(auth.status).json({ error: auth.error })
        return
    }

    const todoistApiKey = process.env.TODOIST_API_KEY
    if (!todoistApiKey) {
        res.status(500).json({ error: 'TODOIST_API_KEY not configured on server' })
        return
    }

    try {
        const server = getMcpServer({
            todoistApiKey,
            baseUrl: process.env.TODOIST_BASE_URL,
        })

        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined, // Stateless mode
        })

        await server.connect(transport)
        await transport.handleRequest(req, res, req.body)

        res.on('close', () => {
            transport.close()
            server.close()
        })
    } catch (error) {
        console.error('[todoist-ai] Error handling MCP request:', error)
        if (!res.headersSent) {
            res.status(500).json({
                jsonrpc: '2.0',
                error: { code: -32603, message: 'Internal server error' },
                id: null,
            })
        }
    }
})

// Block GET/DELETE on /mcp endpoint
app.get('/mcp', (_req: Request, res: Response) => {
    res.status(405).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed. Use POST.' },
        id: null,
    })
})

app.delete('/mcp', (_req: Request, res: Response) => {
    res.status(405).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed.' },
        id: null,
    })
})

// Health check endpoint for Railway
app.get('/health', (_req: Request, res: Response) => {
    res.json({
        ok: Boolean(process.env.TODOIST_API_KEY),
        service: 'Todoist AI Remote MCP',
        version: '6.2.0',
        authConfigured: VALID_API_KEYS.length > 0,
    })
})

// Root info endpoint
app.get('/', (_req: Request, res: Response) => {
    const baseUrl = process.env.MCP_SERVER_URL ?? `http://localhost:${PORT}`
    res.json({
        name: 'Todoist AI Remote MCP',
        version: '6.2.0',
        description: 'Remote MCP server for Todoist task management',
        endpoints: {
            mcp: `${baseUrl}/mcp`,
            health: `${baseUrl}/health`,
        },
        authentication: 'API key required via query parameter (?apiKey=YOUR_KEY)',
        documentation: 'https://github.com/Doist/todoist-ai',
    })
})

app.listen(PORT, '0.0.0.0', () => {
    console.log(`[todoist-ai] Remote MCP server listening on port ${PORT}`)
    console.log(`[todoist-ai] Health check: http://localhost:${PORT}/health`)
    console.log(`[todoist-ai] MCP endpoint: http://localhost:${PORT}/mcp?apiKey=YOUR_KEY`)
})

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('[todoist-ai] Shutting down server...')
    process.exit(0)
})

process.on('SIGTERM', () => {
    console.log('[todoist-ai] Received SIGTERM, shutting down...')
    process.exit(0)
})
