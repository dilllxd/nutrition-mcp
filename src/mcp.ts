import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type { Context } from "hono";
import {
    insertMeal,
    getMealsByDate,
    getMealsInRange,
    deleteMeal,
    updateMeal,
    deleteAllUserData,
    type Meal,
} from "./supabase.js";
import { withAnalytics } from "./analytics.js";

const sessions = new Map<
    string,
    {
        transport: WebStandardStreamableHTTPServerTransport;
        mcpToken: string;
    }
>();

/**
 * Returns the current date as YYYY-MM-DD in the given IANA timezone.
 * Falls back to UTC if no timezone is provided.
 */
function todayDate(timezone?: string): string {
    if (!timezone) {
        return new Date().toISOString().slice(0, 10);
    }
    // en-CA locale uses YYYY-MM-DD format natively
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(new Date());
}

/**
 * Returns the current date-time as a timezone-aware ISO 8601 string
 * (e.g. "2026-03-24T20:09:00-04:00") in the given IANA timezone.
 * Falls back to UTC ISO string if no timezone is provided.
 */
function nowInTimezone(timezone?: string): string {
    if (!timezone) {
        return new Date().toISOString();
    }
    const now = new Date();
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
    }).formatToParts(now);

    const get = (type: string) =>
        parts.find((p) => p.type === type)?.value ?? "00";

    const year = get("year");
    const month = get("month");
    const day = get("day");
    // hour12: false can return "24" at midnight — normalize to "00"
    const hour = get("hour") === "24" ? "00" : get("hour");
    const minute = get("minute");
    const second = get("second");

    // Compute the UTC offset for this timezone at this moment
    const utcDate = new Date(
        `${year}-${month}-${day}T${hour}:${minute}:${second}`,
    );
    const offsetMs = now.getTime() - utcDate.getTime();
    const offsetTotalMinutes = Math.round(offsetMs / 60000);
    const sign = offsetTotalMinutes >= 0 ? "+" : "-";
    const absMinutes = Math.abs(offsetTotalMinutes);
    const offsetH = String(Math.floor(absMinutes / 60)).padStart(2, "0");
    const offsetM = String(absMinutes % 60).padStart(2, "0");

    return `${year}-${month}-${day}T${hour}:${minute}:${second}${sign}${offsetH}:${offsetM}`;
}

function formatMeal(meal: Meal): string {
    const parts = [
        `ID: ${meal.id}`,
        `Time: ${meal.logged_at}`,
        meal.meal_type ? `Type: ${meal.meal_type}` : null,
        `Description: ${meal.description}`,
        meal.calories != null ? `Calories: ${meal.calories}` : null,
        meal.protein_g != null ? `Protein: ${meal.protein_g}g` : null,
        meal.carbs_g != null ? `Carbs: ${meal.carbs_g}g` : null,
        meal.fat_g != null ? `Fat: ${meal.fat_g}g` : null,
        meal.notes ? `Notes: ${meal.notes}` : null,
    ];
    return parts.filter(Boolean).join("\n");
}

function registerTools(server: McpServer, userId: string) {
    server.registerTool(
        "log_meal",
        {
            title: "Log Meal",
            description:
                "Log a meal entry with nutritional information. If the user doesn't specify the quantity or portion size, ask how much they ate before estimating calories and macros. Use web search to look up accurate nutritional data when appropriate, especially for branded products or barcode scans.",
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: false,
            },
            inputSchema: {
                description: z.string().describe("What was eaten"),
                meal_type: z
                    .enum(["breakfast", "lunch", "dinner", "snack"])
                    .describe(
                        "Type of meal (breakfast, lunch, dinner, or snack). Always ask the user if not provided.",
                    ),
                calories: z.number().optional().describe("Total calories"),
                protein_g: z.number().optional().describe("Protein in grams"),
                carbs_g: z
                    .number()
                    .optional()
                    .describe("Carbohydrates in grams"),
                fat_g: z.number().optional().describe("Fat in grams"),
                logged_at: z
                    .string()
                    .optional()
                    .describe(
                        "ISO 8601 timestamp (defaults to now). If you don't know the current date or time, ask the user before calling this tool.",
                    ),
                timezone: z
                    .string()
                    .optional()
                    .describe(
                        "IANA timezone string for the user's local timezone (e.g. 'America/New_York'). Used to determine the correct local date and time when logged_at is not provided.",
                    ),
                notes: z.string().optional().describe("Additional notes"),
            },
        },
        async (args) => {
            return withAnalytics(
                "log_meal",
                async () => {
                    const meal = await insertMeal(userId, args);
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Meal logged:\n${formatMeal(meal)}`,
                            },
                        ],
                    };
                },
                { userId },
            );
        },
    );

    server.registerTool(
        "get_meals_today",
        {
            title: "Get Today's Meals",
            description: "Get all meals logged today",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                timezone: z
                    .string()
                    .optional()
                    .describe(
                        "IANA timezone string for the user's local timezone (e.g. 'America/New_York'). Required to correctly determine today's date.",
                    ),
            },
        },
        async ({ timezone }) => {
            return withAnalytics(
                "get_meals_today",
                async () => {
                    const meals = await getMealsByDate(
                        userId,
                        todayDate(timezone),
                        timezone,
                    );
                    if (meals.length === 0) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: "No meals logged today.",
                                },
                            ],
                        };
                    }
                    const text = meals.map(formatMeal).join("\n\n---\n\n");
                    return { content: [{ type: "text", text }] };
                },
                { userId },
            );
        },
    );

    server.registerTool(
        "get_meals_by_date",
        {
            title: "Get Meals by Date",
            description: "Get all meals for a specific date",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                date: z.string().describe("Date in YYYY-MM-DD format"),
                timezone: z
                    .string()
                    .optional()
                    .describe(
                        "IANA timezone string for the user's local timezone (e.g. 'America/New_York'). Used to correctly bound the day's start and end times.",
                    ),
            },
        },
        async ({ date, timezone }) => {
            return withAnalytics(
                "get_meals_by_date",
                async () => {
                    const meals = await getMealsByDate(userId, date, timezone);
                    if (meals.length === 0) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `No meals logged on ${date}.`,
                                },
                            ],
                        };
                    }
                    const text = meals.map(formatMeal).join("\n\n---\n\n");
                    return { content: [{ type: "text", text }] };
                },
                { userId },
                { date },
            );
        },
    );

    server.registerTool(
        "get_meals_by_date_range",
        {
            title: "Get Meals by Date Range",
            description:
                "Get all meals between two dates (inclusive). Use this instead of multiple get_meals_by_date calls when you need meals for more than one day.",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                start_date: z.string().describe("Start date (YYYY-MM-DD)"),
                end_date: z.string().describe("End date (YYYY-MM-DD)"),
                timezone: z
                    .string()
                    .optional()
                    .describe(
                        "IANA timezone string for the user's local timezone (e.g. 'America/New_York'). Used to correctly bound day start/end times.",
                    ),
            },
        },
        async ({ start_date, end_date, timezone }) => {
            return withAnalytics(
                "get_meals_by_date_range",
                async () => {
                    const meals = await getMealsInRange(
                        userId,
                        start_date,
                        end_date,
                        timezone,
                    );
                    if (meals.length === 0) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `No meals found between ${start_date} and ${end_date}.`,
                                },
                            ],
                        };
                    }

                    // Group by date for readability
                    const byDate = new Map<string, Meal[]>();
                    for (const meal of meals) {
                        const date = meal.logged_at.slice(0, 10);
                        const existing = byDate.get(date) ?? [];
                        existing.push(meal);
                        byDate.set(date, existing);
                    }

                    const sections: string[] = [];
                    for (const [date, dateMeals] of [
                        ...byDate.entries(),
                    ].sort()) {
                        const header = `## ${date} (${dateMeals.length} meal${dateMeals.length === 1 ? "" : "s"})`;
                        const formatted = dateMeals
                            .map(formatMeal)
                            .join("\n\n---\n\n");
                        sections.push(`${header}\n\n${formatted}`);
                    }

                    return {
                        content: [
                            {
                                type: "text",
                                text: sections.join("\n\n===\n\n"),
                            },
                        ],
                    };
                },
                { userId },
                { start_date, end_date },
            );
        },
    );

    server.registerTool(
        "get_nutrition_summary",
        {
            title: "Get Nutrition Summary",
            description: "Get daily nutrition totals for a date range",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                start_date: z.string().describe("Start date (YYYY-MM-DD)"),
                end_date: z.string().describe("End date (YYYY-MM-DD)"),
                timezone: z
                    .string()
                    .optional()
                    .describe(
                        "IANA timezone string for the user's local timezone (e.g. 'America/New_York'). Used to correctly bound day start/end times.",
                    ),
            },
        },
        async ({ start_date, end_date, timezone }) => {
            return withAnalytics(
                "get_nutrition_summary",
                async () => {
                    const meals = await getMealsInRange(
                        userId,
                        start_date,
                        end_date,
                        timezone,
                    );
                    if (meals.length === 0) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `No meals found between ${start_date} and ${end_date}.`,
                                },
                            ],
                        };
                    }

                    // Group by date
                    const byDate = new Map<string, Meal[]>();
                    for (const meal of meals) {
                        const date = meal.logged_at.slice(0, 10);
                        const existing = byDate.get(date) ?? [];
                        existing.push(meal);
                        byDate.set(date, existing);
                    }

                    const summaries: string[] = [];
                    for (const [date, dateMeals] of [
                        ...byDate.entries(),
                    ].sort()) {
                        const totals = {
                            calories: 0,
                            protein_g: 0,
                            carbs_g: 0,
                            fat_g: 0,
                            count: dateMeals.length,
                        };
                        for (const m of dateMeals) {
                            totals.calories += m.calories ?? 0;
                            totals.protein_g += m.protein_g ?? 0;
                            totals.carbs_g += m.carbs_g ?? 0;
                            totals.fat_g += m.fat_g ?? 0;
                        }
                        summaries.push(
                            `${date} (${totals.count} meals): ${totals.calories} kcal | P: ${totals.protein_g}g | C: ${totals.carbs_g}g | F: ${totals.fat_g}g`,
                        );
                    }

                    return {
                        content: [{ type: "text", text: summaries.join("\n") }],
                    };
                },
                { userId },
                { start_date, end_date },
            );
        },
    );

    server.registerTool(
        "delete_meal",
        {
            title: "Delete Meal",
            description: "Delete a meal entry by ID",
            annotations: {
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                id: z.string().describe("UUID of the meal to delete"),
            },
        },
        async ({ id }) => {
            return withAnalytics(
                "delete_meal",
                async () => {
                    await deleteMeal(userId, id);
                    return {
                        content: [
                            { type: "text", text: `Meal ${id} deleted.` },
                        ],
                    };
                },
                { userId },
            );
        },
    );

    server.registerTool(
        "update_meal",
        {
            title: "Update Meal",
            description: "Update fields of an existing meal entry",
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                id: z.string().describe("UUID of the meal to update"),
                description: z.string().optional(),
                meal_type: z
                    .enum(["breakfast", "lunch", "dinner", "snack"])
                    .optional(),
                calories: z.number().optional(),
                protein_g: z.number().optional(),
                carbs_g: z.number().optional(),
                fat_g: z.number().optional(),
                logged_at: z.string().optional(),
                notes: z.string().optional(),
            },
        },
        async ({ id, ...fields }) => {
            return withAnalytics(
                "update_meal",
                async () => {
                    const meal = await updateMeal(userId, id, fields);
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Meal updated:\n${formatMeal(meal)}`,
                            },
                        ],
                    };
                },
                { userId },
            );
        },
    );
    server.registerTool(
        "delete_account",
        {
            title: "Delete Account",
            description:
                "Permanently delete the user's account and all associated data (meals, tokens, auth). This action is irreversible. Always confirm with the user before calling this tool.",
            annotations: {
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: false,
                openWorldHint: false,
            },
            inputSchema: {
                confirm: z
                    .boolean()
                    .describe(
                        "Must be true to confirm deletion. Always ask the user for explicit confirmation before setting this to true.",
                    ),
            },
        },
        async ({ confirm }) => {
            return withAnalytics(
                "delete_account",
                async () => {
                    if (!confirm) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: "Account deletion cancelled. No data was removed.",
                                },
                            ],
                        };
                    }
                    await deleteAllUserData(userId);
                    return {
                        content: [
                            {
                                type: "text",
                                text: "Your account and all associated data have been permanently deleted.",
                            },
                        ],
                    };
                },
                { userId },
            );
        },
    );
}

export const handleMcp = async (c: Context) => {
    const mcpToken = c.get("accessToken") as string;
    const userId = c.get("userId") as string;
    const sessionId = c.req.header("mcp-session-id");

    const session = sessionId ? sessions.get(sessionId) : undefined;

    if (sessionId && !session) {
        return c.json({ error: "invalid_session" }, 404);
    }

    if (session && session.mcpToken !== mcpToken) {
        return c.json({ error: "forbidden" }, 403);
    }

    if (session) {
        return session.transport.handleRequest(c.req.raw);
    }

    if (c.req.method !== "POST") {
        return c.json({ error: "invalid_request" }, 400);
    }

    const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (id) => {
            sessions.set(id, { transport, mcpToken });
        },
        onsessionclosed: (id) => {
            sessions.delete(id);
        },
    });

    const proto = c.req.header("x-forwarded-proto") || "http";
    const host =
        c.req.header("x-forwarded-host") || c.req.header("host") || "localhost";
    const baseUrl = `${proto}://${host}`;

    const server = new McpServer(
        {
            name: "nutrition-mcp",
            version: "1.6.0",
            icons: [
                {
                    src: `${baseUrl}/favicon.ico`,
                    mimeType: "image/x-icon",
                },
            ],
        },
        { capabilities: { tools: {} } },
    );

    registerTools(server, userId);
    await server.connect(transport);

    return transport.handleRequest(c.req.raw);
};

// Export nowInTimezone for use in supabase.ts
export { nowInTimezone };
