import { Hono } from "hono";
import crypto from "node:crypto";
import {
    storeToken,
    storeAuthCode,
    consumeAuthCode,
    signUpUser,
    signInUser,
    storeRefreshToken,
    consumeRefreshToken,
} from "./supabase.js";

const SESSION_TTL_MS = 10 * 60 * 1000;

interface OAuthSession {
    state: string;
    redirectUri: string;
    codeChallenge?: string;
    clientId: string;
}

// In-memory session store (sessions are short-lived, 10min TTL)
const sessions = new Map<
    string,
    { session: OAuthSession; expiresAt: number }
>();

function cleanExpiredSessions() {
    const now = Date.now();
    for (const [key, value] of sessions) {
        if (value.expiresAt < now) sessions.delete(key);
    }
}

function base64URLEncode(buffer: Buffer): string {
    return buffer
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=/g, "");
}

function escapeHtml(str: string): string {
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

export function createOAuthRouter() {
    const oauth = new Hono();

    const clientId = process.env.OAUTH_CLIENT_ID;
    const clientSecret = process.env.OAUTH_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        throw new Error("Missing OAUTH_CLIENT_ID or OAUTH_CLIENT_SECRET");
    }

    // Dynamic client registration (required by MCP spec)
    oauth.post("/register", async (c) => {
        const body = await c.req.json();

        return c.json({
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uris: body.redirect_uris || [],
        });
    });

    // Authorization endpoint
    oauth.get("/authorize", async (c) => {
        const responseType = c.req.query("response_type");
        const reqClientId = c.req.query("client_id");
        const redirectUri = c.req.query("redirect_uri");
        const state = c.req.query("state");
        const codeChallenge = c.req.query("code_challenge");

        if (responseType !== "code") {
            return c.json({ error: "unsupported_response_type" }, 400);
        }
        if (!redirectUri || !state || !reqClientId) {
            return c.json(
                {
                    error: "invalid_request",
                    error_description:
                        "client_id, redirect_uri, and state are required",
                },
                400,
            );
        }
        if (reqClientId !== clientId) {
            return c.json({ error: "invalid_client" }, 400);
        }

        cleanExpiredSessions();

        // Store session and show login page
        const sessionId = crypto.randomUUID();
        sessions.set(sessionId, {
            session: {
                state,
                redirectUri,
                codeChallenge,
                clientId: reqClientId,
            },
            expiresAt: Date.now() + SESSION_TTL_MS,
        });

        return c.html(loginPage(sessionId));
    });

    // Login/register endpoint — user submits email + password
    oauth.post("/approve", async (c) => {
        const body = await c.req.parseBody();
        const sessionId = body.session_id as string;
        const email = (body.email as string)?.trim().toLowerCase();
        const password = body.password as string;
        const action = body.action as string;

        if (!sessionId || !email || !password) {
            return c.json({ error: "invalid_request" }, 400);
        }

        const entry = sessions.get(sessionId);
        if (!entry || entry.expiresAt < Date.now()) {
            sessions.delete(sessionId);
            return c.json({ error: "session_expired" }, 400);
        }

        let userId: string;
        try {
            if (action === "register") {
                userId = await signUpUser(email, password);
            } else {
                userId = await signInUser(email, password);
            }
        } catch (err: unknown) {
            const message =
                err instanceof Error ? err.message : "Authentication failed";
            return c.html(loginPage(sessionId, message), 400);
        }

        const session = entry.session;
        sessions.delete(sessionId);

        // Generate authorization code linked to the authenticated user
        const authCode = crypto.randomUUID();
        await storeAuthCode(
            authCode,
            session.redirectUri,
            userId,
            session.codeChallenge,
        );

        // Redirect back to MCP client with code + state
        const redirectUrl = new URL(session.redirectUri);
        redirectUrl.searchParams.set("code", authCode);
        redirectUrl.searchParams.set("state", session.state);

        return c.redirect(redirectUrl.toString());
    });

    // Token endpoint
    oauth.post("/token", async (c) => {
        const body = await c.req.parseBody();
        const grantType = body.grant_type as string;
        const code = body.code as string;
        const codeVerifier = body.code_verifier as string | undefined;
        const redirectUri = body.redirect_uri as string;
        const reqClientId = body.client_id as string | undefined;
        const reqClientSecret = body.client_secret as string | undefined;

        if (grantType === "refresh_token") {
            const refreshToken = body.refresh_token as string;
            if (!refreshToken) {
                return c.json({ error: "invalid_request" }, 400);
            }

            // Look up the existing user from the refresh token
            const userId = await consumeRefreshToken(refreshToken);
            if (!userId) {
                return c.json({ error: "invalid_grant" }, 400);
            }

            const newAccessToken = crypto.randomUUID();
            const newRefreshToken = crypto.randomUUID();
            await storeToken(newAccessToken, userId);
            await storeRefreshToken(newRefreshToken, userId);

            return c.json({
                access_token: newAccessToken,
                token_type: "Bearer",
                expires_in: 365 * 24 * 60 * 60,
                refresh_token: newRefreshToken,
            });
        }

        if (grantType !== "authorization_code") {
            return c.json({ error: "unsupported_grant_type" }, 400);
        }

        if (!code) {
            return c.json({ error: "invalid_request" }, 400);
        }

        // Validate client credentials if provided
        if (reqClientId && reqClientId !== clientId) {
            return c.json({ error: "invalid_client" }, 401);
        }
        if (reqClientSecret && reqClientSecret !== clientSecret) {
            return c.json({ error: "invalid_client" }, 401);
        }

        // Atomically consume the auth code
        const authCodeData = await consumeAuthCode(code);
        if (!authCodeData) {
            return c.json({ error: "invalid_grant" }, 400);
        }

        // Validate redirect_uri
        if (redirectUri && redirectUri !== authCodeData.redirect_uri) {
            return c.json({ error: "invalid_grant" }, 400);
        }

        // Validate PKCE
        if (authCodeData.code_challenge) {
            if (!codeVerifier) {
                return c.json(
                    {
                        error: "invalid_request",
                        error_description: "code_verifier required",
                    },
                    400,
                );
            }
            const hash = base64URLEncode(
                Buffer.from(
                    crypto.createHash("sha256").update(codeVerifier).digest(),
                ),
            );
            if (hash !== authCodeData.code_challenge) {
                return c.json({ error: "invalid_grant" }, 400);
            }
        }

        // Issue tokens linked to the authenticated user
        const accessToken = crypto.randomUUID();
        const refreshToken = crypto.randomUUID();
        await storeToken(accessToken, authCodeData.user_id);
        await storeRefreshToken(refreshToken, authCodeData.user_id);

        return c.json({
            access_token: accessToken,
            token_type: "Bearer",
            expires_in: 365 * 24 * 60 * 60,
            refresh_token: refreshToken,
        });
    });

    return oauth;
}

function loginPage(sessionId: string, error?: string): string {
    const errorHtml = error ? `<p class="error">${escapeHtml(error)}</p>` : "";

    return `<!DOCTYPE html>
<html>
<head>
    <title>Nutrition MCP — Sign In</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        body { font-family: system-ui, sans-serif; max-width: 400px; margin: 80px auto; padding: 0 20px; }
        h1 { font-size: 1.5rem; text-align: center; }
        p.subtitle { color: #666; text-align: center; margin: 0.5rem 0 2rem; }
        label { display: block; font-size: 0.875rem; font-weight: 500; margin-bottom: 0.25rem; }
        input[type="email"], input[type="password"] {
            width: 100%; padding: 10px; border: 1px solid #d1d5db; border-radius: 6px;
            font-size: 1rem; margin-bottom: 1rem; box-sizing: border-box;
        }
        .buttons { display: flex; gap: 0.75rem; margin-top: 0.5rem; }
        button {
            flex: 1; padding: 12px; border: none; border-radius: 8px;
            font-size: 1rem; cursor: pointer; font-weight: 500;
        }
        .btn-primary { background: #2563eb; color: white; }
        .btn-primary:hover { background: #1d4ed8; }
        .btn-secondary { background: #f3f4f6; color: #374151; border: 1px solid #d1d5db; }
        .btn-secondary:hover { background: #e5e7eb; }
        .error { color: #dc2626; background: #fef2f2; border: 1px solid #fecaca; padding: 10px; border-radius: 6px; text-align: center; margin-bottom: 1rem; }
    </style>
</head>
<body>
    <h1>Nutrition MCP</h1>
    <p class="subtitle">Sign in or create an account to connect</p>
    ${errorHtml}
    <form method="POST" action="/approve">
        <input type="hidden" name="session_id" value="${escapeHtml(sessionId)}" />
        <label for="email">Email</label>
        <input type="email" id="email" name="email" required autocomplete="email" />
        <label for="password">Password</label>
        <input type="password" id="password" name="password" required minlength="6" autocomplete="current-password" />
        <div class="buttons">
            <button type="submit" name="action" value="login" class="btn-primary">Sign In</button>
            <button type="submit" name="action" value="register" class="btn-secondary">Register</button>
        </div>
    </form>
</body>
</html>`;
}
