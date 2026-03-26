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
    insertRecipe,
    getRecipes,
    getRecipeById,
    updateRecipe,
    deleteRecipe,
    insertMealPlan,
    getMealPlanByDate,
    getMealPlanByDateRange,
    getMealPlanById,
    deleteMealPlan,
    calculateScaledMacros,
    insertWeight,
    getLatestWeight,
    getWeightHistory,
    getWeightStats,
    getGoalProgress,
    updateWeight,
    deleteWeight,
    insertWater,
    getWaterToday,
    searchMeals,
    type Meal,
    type Recipe,
    type MealPlan,
    type WeightEntry,
} from "./db.js";
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

function formatRecipe(recipe: Recipe): string {
    const parts = [
        `ID: ${recipe.id}`,
        `Name: ${recipe.name}`,
        recipe.description ? `Description: ${recipe.description}` : null,
        `Servings: ${recipe.servings}`,
        recipe.tags && recipe.tags.length > 0
            ? `Tags: ${recipe.tags.join(", ")}`
            : null,
        recipe.ingredients && recipe.ingredients.length > 0
            ? `Ingredients:\n${recipe.ingredients.map((i) => `  - ${i}`).join("\n")}`
            : null,
        recipe.steps && recipe.steps.length > 0
            ? `Steps:\n${recipe.steps.map((s, idx) => `  ${idx + 1}. ${s}`).join("\n")}`
            : null,
        recipe.calories_per_serving != null
            ? `Calories/serving: ${recipe.calories_per_serving}`
            : null,
        recipe.protein_g_per_serving != null
            ? `Protein/serving: ${recipe.protein_g_per_serving}g`
            : null,
        recipe.carbs_g_per_serving != null
            ? `Carbs/serving: ${recipe.carbs_g_per_serving}g`
            : null,
        recipe.fat_g_per_serving != null
            ? `Fat/serving: ${recipe.fat_g_per_serving}g`
            : null,
    ];
    return parts.filter(Boolean).join("\n");
}

function formatMealPlan(plan: MealPlan): string {
    const parts = [
        `ID: ${plan.id}`,
        `Date: ${plan.date}`,
        `Slot: ${plan.slot}`,
        plan.recipe_id ? `Recipe ID: ${plan.recipe_id}` : null,
        plan.custom_description
            ? `Description: ${plan.custom_description}`
            : null,
        `Servings: ${plan.servings}`,
        plan.calories != null ? `Calories: ${plan.calories}` : null,
        plan.protein_g != null ? `Protein: ${plan.protein_g}g` : null,
        plan.carbs_g != null ? `Carbs: ${plan.carbs_g}g` : null,
        plan.fat_g != null ? `Fat: ${plan.fat_g}g` : null,
        plan.notes ? `Notes: ${plan.notes}` : null,
    ];
    return parts.filter(Boolean).join("\n");
}

function formatWeightEntry(entry: WeightEntry): string {
    const parts = [
        `ID: ${entry.id}`,
        `Date: ${typeof entry.date === "string" ? entry.date.slice(0, 10) : entry.date}`,
        `Weight: ${entry.weight_lb} lbs`,
        entry.notes ? `Notes: ${entry.notes}` : null,
    ];
    return parts.filter(Boolean).join("\n");
}

// Default target weight in pounds for goal progress calculations
const DEFAULT_TARGET_WEIGHT_LB = 130;

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

    // ---------- Recipe tools ----------

    server.registerTool(
        "save_recipe",
        {
            title: "Save Recipe",
            description:
                "Save a new recipe with ingredients, preparation steps, tags, and per-serving macros.",
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: false,
            },
            inputSchema: {
                name: z.string().describe("Recipe name"),
                description: z
                    .string()
                    .optional()
                    .describe("Short description of the recipe"),
                ingredients: z
                    .array(z.string())
                    .optional()
                    .describe(
                        "List of ingredients (e.g. '200g chicken breast')",
                    ),
                steps: z
                    .array(z.string())
                    .optional()
                    .describe("Preparation steps in order"),
                tags: z
                    .array(z.string())
                    .optional()
                    .describe(
                        "Tags for categorisation (e.g. 'high-protein', 'quick')",
                    ),
                servings: z
                    .number()
                    .optional()
                    .describe(
                        "Number of servings the recipe yields (default 1)",
                    ),
                calories_per_serving: z
                    .number()
                    .optional()
                    .describe("Calories per serving"),
                protein_g_per_serving: z
                    .number()
                    .optional()
                    .describe("Protein in grams per serving"),
                carbs_g_per_serving: z
                    .number()
                    .optional()
                    .describe("Carbohydrates in grams per serving"),
                fat_g_per_serving: z
                    .number()
                    .optional()
                    .describe("Fat in grams per serving"),
            },
        },
        async (args) => {
            return withAnalytics(
                "save_recipe",
                async () => {
                    const recipe = await insertRecipe(userId, args);
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Recipe saved:\n${formatRecipe(recipe)}`,
                            },
                        ],
                    };
                },
                { userId },
            );
        },
    );

    server.registerTool(
        "get_recipes",
        {
            title: "Get Recipes",
            description:
                "List all saved recipes, optionally filtered by a tag.",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                tag: z
                    .string()
                    .optional()
                    .describe("Filter recipes by this tag"),
            },
        },
        async ({ tag }) => {
            return withAnalytics(
                "get_recipes",
                async () => {
                    const recipes = await getRecipes(userId, tag);
                    if (recipes.length === 0) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: tag
                                        ? `No recipes found with tag "${tag}".`
                                        : "No recipes saved yet.",
                                },
                            ],
                        };
                    }
                    const text = recipes.map(formatRecipe).join("\n\n---\n\n");
                    return { content: [{ type: "text", text }] };
                },
                { userId },
            );
        },
    );

    server.registerTool(
        "update_recipe",
        {
            title: "Update Recipe",
            description: "Update fields of an existing saved recipe.",
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                id: z.string().describe("UUID of the recipe to update"),
                name: z.string().optional(),
                description: z.string().optional(),
                ingredients: z.array(z.string()).optional(),
                steps: z.array(z.string()).optional(),
                tags: z.array(z.string()).optional(),
                servings: z.number().optional(),
                calories_per_serving: z.number().optional(),
                protein_g_per_serving: z.number().optional(),
                carbs_g_per_serving: z.number().optional(),
                fat_g_per_serving: z.number().optional(),
            },
        },
        async ({ id, ...fields }) => {
            return withAnalytics(
                "update_recipe",
                async () => {
                    const recipe = await updateRecipe(userId, id, fields);
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Recipe updated:\n${formatRecipe(recipe)}`,
                            },
                        ],
                    };
                },
                { userId },
            );
        },
    );

    server.registerTool(
        "delete_recipe",
        {
            title: "Delete Recipe",
            description: "Permanently delete a saved recipe by ID.",
            annotations: {
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                id: z.string().describe("UUID of the recipe to delete"),
            },
        },
        async ({ id }) => {
            return withAnalytics(
                "delete_recipe",
                async () => {
                    await deleteRecipe(userId, id);
                    return {
                        content: [
                            { type: "text", text: `Recipe ${id} deleted.` },
                        ],
                    };
                },
                { userId },
            );
        },
    );

    server.registerTool(
        "log_saved_meal",
        {
            title: "Log Saved Meal",
            description:
                "Log a saved recipe directly as a meal entry. Macros are automatically multiplied by the number of servings eaten.",
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: false,
            },
            inputSchema: {
                recipe_id: z
                    .string()
                    .describe("UUID of the saved recipe to log"),
                servings: z
                    .number()
                    .optional()
                    .describe(
                        "Number of servings eaten (default 1). Macros are scaled by this value.",
                    ),
                meal_type: z
                    .enum(["breakfast", "lunch", "dinner", "snack"])
                    .describe("Meal type"),
                logged_at: z
                    .string()
                    .optional()
                    .describe(
                        "ISO 8601 timestamp (defaults to now). Ask the user if the current time is unknown.",
                    ),
                timezone: z
                    .string()
                    .optional()
                    .describe(
                        "IANA timezone string (e.g. 'America/New_York'). Used when logged_at is not provided.",
                    ),
                notes: z.string().optional().describe("Additional notes"),
            },
        },
        async ({
            recipe_id,
            servings = 1,
            meal_type,
            logged_at,
            timezone,
            notes,
        }) => {
            return withAnalytics(
                "log_saved_meal",
                async () => {
                    const recipe = await getRecipeById(userId, recipe_id);
                    if (!recipe) throw new Error("Recipe not found");

                    const scaled = calculateScaledMacros(recipe, servings);
                    const description =
                        servings === 1
                            ? recipe.name
                            : `${recipe.name} (×${servings})`;

                    const meal = await insertMeal(userId, {
                        description,
                        meal_type,
                        calories: scaled.calories ?? undefined,
                        protein_g: scaled.protein_g ?? undefined,
                        carbs_g: scaled.carbs_g ?? undefined,
                        fat_g: scaled.fat_g ?? undefined,
                        logged_at,
                        timezone,
                        notes,
                    });

                    return {
                        content: [
                            {
                                type: "text",
                                text: `Meal logged from recipe "${recipe.name}":\n${formatMeal(meal)}`,
                            },
                        ],
                    };
                },
                { userId },
            );
        },
    );

    // ---------- Meal plan tools ----------

    server.registerTool(
        "plan_meal",
        {
            title: "Plan Meal",
            description:
                "Plan a meal for a specific date and slot (breakfast/lunch/dinner/snack). When a recipe is linked, macros are auto-filled from it if not explicitly provided.",
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: false,
            },
            inputSchema: {
                date: z
                    .string()
                    .describe("Date to plan the meal for (YYYY-MM-DD)"),
                slot: z
                    .enum(["breakfast", "lunch", "dinner", "snack"])
                    .describe("Meal slot"),
                recipe_id: z
                    .string()
                    .optional()
                    .describe(
                        "UUID of a saved recipe to link. Macros are auto-filled from the recipe when not provided.",
                    ),
                servings: z
                    .number()
                    .optional()
                    .describe("Number of servings (default 1)"),
                custom_description: z
                    .string()
                    .optional()
                    .describe(
                        "Custom meal description (used when no recipe is linked)",
                    ),
                calories: z
                    .number()
                    .optional()
                    .describe(
                        "Override calories (auto-filled from recipe when omitted)",
                    ),
                protein_g: z.number().optional(),
                carbs_g: z.number().optional(),
                fat_g: z.number().optional(),
                notes: z.string().optional(),
            },
        },
        async (args) => {
            return withAnalytics(
                "plan_meal",
                async () => {
                    const plan = await insertMealPlan(userId, args);
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Meal planned:\n${formatMealPlan(plan)}`,
                            },
                        ],
                    };
                },
                { userId },
                { date: args.date },
            );
        },
    );

    server.registerTool(
        "get_meal_plan",
        {
            title: "Get Meal Plan",
            description:
                "Get planned meals for a specific date or a date range (weekly plan). Provide only start_date for a single day, or both start_date and end_date for a range.",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                start_date: z
                    .string()
                    .describe(
                        "Start date (YYYY-MM-DD). Used alone for a single day.",
                    ),
                end_date: z
                    .string()
                    .optional()
                    .describe(
                        "End date (YYYY-MM-DD). When provided, returns the full date range.",
                    ),
            },
        },
        async ({ start_date, end_date }) => {
            return withAnalytics(
                "get_meal_plan",
                async () => {
                    const plans = end_date
                        ? await getMealPlanByDateRange(
                              userId,
                              start_date,
                              end_date,
                          )
                        : await getMealPlanByDate(userId, start_date);

                    if (plans.length === 0) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: end_date
                                        ? `No meals planned between ${start_date} and ${end_date}.`
                                        : `No meals planned for ${start_date}.`,
                                },
                            ],
                        };
                    }

                    // Group by date
                    const byDate = new Map<string, MealPlan[]>();
                    for (const plan of plans) {
                        const d =
                            typeof plan.date === "string"
                                ? plan.date.slice(0, 10)
                                : plan.date;
                        const existing = byDate.get(d) ?? [];
                        existing.push(plan);
                        byDate.set(d, existing);
                    }

                    const sections: string[] = [];
                    for (const [date, datePlans] of [
                        ...byDate.entries(),
                    ].sort()) {
                        const header = `## ${date}`;
                        const formatted = datePlans
                            .map(formatMealPlan)
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
        "delete_planned_meal",
        {
            title: "Delete Planned Meal",
            description: "Remove a planned meal entry by ID.",
            annotations: {
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                id: z.string().describe("UUID of the planned meal to delete"),
            },
        },
        async ({ id }) => {
            return withAnalytics(
                "delete_planned_meal",
                async () => {
                    await deleteMealPlan(userId, id);
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Planned meal ${id} deleted.`,
                            },
                        ],
                    };
                },
                { userId },
            );
        },
    );

    server.registerTool(
        "log_planned_meal",
        {
            title: "Log Planned Meal",
            description:
                "Log a planned meal to actual meal history. Copies the planned meal's macros and description into the meal log.",
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: false,
            },
            inputSchema: {
                id: z
                    .string()
                    .describe("UUID of the planned meal to log as eaten"),
                logged_at: z
                    .string()
                    .optional()
                    .describe(
                        "ISO 8601 timestamp (defaults to now). Ask the user if the current time is unknown.",
                    ),
                timezone: z
                    .string()
                    .optional()
                    .describe(
                        "IANA timezone string (e.g. 'America/New_York'). Used when logged_at is not provided.",
                    ),
                notes: z
                    .string()
                    .optional()
                    .describe("Additional notes for the logged meal"),
            },
        },
        async ({ id, logged_at, timezone, notes }) => {
            return withAnalytics(
                "log_planned_meal",
                async () => {
                    const plan = await getMealPlanById(userId, id);
                    if (!plan) throw new Error("Planned meal not found");

                    // Resolve description: prefer custom, else look up recipe name
                    let description = plan.custom_description;
                    if (!description && plan.recipe_id) {
                        const recipe = await getRecipeById(
                            userId,
                            plan.recipe_id,
                        );
                        description = recipe
                            ? plan.servings === 1
                                ? recipe.name
                                : `${recipe.name} (×${plan.servings})`
                            : null;
                    }
                    if (!description)
                        description = `Planned ${plan.slot} on ${typeof plan.date === "string" ? plan.date.slice(0, 10) : plan.date}`;

                    const meal = await insertMeal(userId, {
                        description,
                        meal_type: plan.slot,
                        calories: plan.calories ?? undefined,
                        protein_g: plan.protein_g ?? undefined,
                        carbs_g: plan.carbs_g ?? undefined,
                        fat_g: plan.fat_g ?? undefined,
                        logged_at,
                        timezone,
                        notes: notes ?? plan.notes ?? undefined,
                    });

                    return {
                        content: [
                            {
                                type: "text",
                                text: `Planned meal logged:\n${formatMeal(meal)}`,
                            },
                        ],
                    };
                },
                { userId },
            );
        },
    );

    // ---------- Weight tracking tools ----------

    server.registerTool(
        "log_weight",
        {
            title: "Log Weight",
            description:
                "Log a weigh-in entry. Use for weekly Thursday weigh-ins or mid-week checks.",
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: false,
            },
            inputSchema: {
                weight_lb: z.number().describe("Body weight in pounds"),
                date: z
                    .string()
                    .optional()
                    .describe(
                        "Date of the weigh-in (YYYY-MM-DD, defaults to today). Ask the user if today's date is unknown.",
                    ),
                timezone: z
                    .string()
                    .optional()
                    .describe(
                        "IANA timezone string (e.g. 'America/New_York'). Used to determine today's date when date is not provided.",
                    ),
                notes: z
                    .string()
                    .optional()
                    .describe("Optional notes about this weigh-in"),
            },
        },
        async ({ weight_lb, date, timezone, notes }) => {
            return withAnalytics(
                "log_weight",
                async () => {
                    const dateVal = date ?? todayDate(timezone);
                    const entry = await insertWeight(
                        userId,
                        weight_lb,
                        dateVal,
                        notes,
                    );
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Weight logged:\n${formatWeightEntry(entry)}`,
                            },
                        ],
                    };
                },
                { userId },
            );
        },
    );

    server.registerTool(
        "get_latest_weight",
        {
            title: "Get Latest Weight",
            description:
                "Get the most recent weigh-in entry. Useful for pulling the current baseline into the daily brief or summaries.",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {},
        },
        async () => {
            return withAnalytics(
                "get_latest_weight",
                async () => {
                    const entry = await getLatestWeight(userId);
                    if (!entry) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: "No weight entries found.",
                                },
                            ],
                        };
                    }
                    return {
                        content: [
                            {
                                type: "text",
                                text: formatWeightEntry(entry),
                            },
                        ],
                    };
                },
                { userId },
            );
        },
    );

    server.registerTool(
        "get_weight_history",
        {
            title: "Get Weight History",
            description:
                "Get a list of weigh-in entries. Provide either limit (most recent N entries) or days (entries from the last N days).",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                limit: z
                    .number()
                    .optional()
                    .describe(
                        "Return the most recent N entries (default 10). Ignored when days is provided.",
                    ),
                days: z
                    .number()
                    .optional()
                    .describe(
                        "Return entries from the last N days. Takes precedence over limit.",
                    ),
            },
        },
        async ({ limit, days }) => {
            return withAnalytics(
                "get_weight_history",
                async () => {
                    const entries = await getWeightHistory(userId, limit, days);
                    if (entries.length === 0) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: "No weight entries found.",
                                },
                            ],
                        };
                    }
                    const text = entries
                        .map(formatWeightEntry)
                        .join("\n\n---\n\n");
                    return { content: [{ type: "text", text }] };
                },
                { userId },
            );
        },
    );

    server.registerTool(
        "get_weight_stats",
        {
            title: "Get Weight Stats",
            description:
                "Get weight loss statistics: total lost, average loss per week, and average loss per month. Useful for tracking progress toward a target loss rate.",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {},
        },
        async () => {
            return withAnalytics(
                "get_weight_stats",
                async () => {
                    const stats = await getWeightStats(userId);
                    if (stats.entry_count < 2) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text:
                                        stats.entry_count === 0
                                            ? "No weight entries found. Log at least two weigh-ins to see stats."
                                            : "Only one weight entry found. Log at least two weigh-ins to calculate stats.",
                                },
                            ],
                        };
                    }
                    const lines = [
                        `Total lost: ${stats.total_lost_lb} lbs`,
                        `Average loss per week: ${stats.avg_loss_per_week_lb} lbs`,
                        `Average loss per month: ${stats.avg_loss_per_month_lb} lbs`,
                        `Based on ${stats.entry_count} weigh-ins`,
                    ];
                    return {
                        content: [{ type: "text", text: lines.join("\n") }],
                    };
                },
                { userId },
            );
        },
    );

    server.registerTool(
        "get_goal_progress",
        {
            title: "Get Goal Progress",
            description:
                "Get progress toward a weight loss goal: total lost, lbs remaining, and percentage of goal completed.",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                target_lb: z
                    .number()
                    .optional()
                    .describe(
                        `Target weight in pounds (default ${DEFAULT_TARGET_WEIGHT_LB})`,
                    ),
            },
        },
        async ({ target_lb = DEFAULT_TARGET_WEIGHT_LB }) => {
            return withAnalytics(
                "get_goal_progress",
                async () => {
                    const progress = await getGoalProgress(userId, target_lb);
                    if (progress.current_weight_lb === null) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: "No weight entries found. Log a weigh-in to track goal progress.",
                                },
                            ],
                        };
                    }
                    const lines = [
                        `Target: ${progress.target_lb} lbs`,
                        `Starting weight: ${progress.starting_weight_lb} lbs`,
                        `Current weight: ${progress.current_weight_lb} lbs`,
                        `Total lost: ${progress.total_lost_lb} lbs`,
                        `Remaining: ${progress.lbs_remaining} lbs`,
                        `Goal completion: ${progress.percent_complete}%`,
                    ];
                    return {
                        content: [{ type: "text", text: lines.join("\n") }],
                    };
                },
                { userId },
            );
        },
    );

    server.registerTool(
        "update_weight",
        {
            title: "Update Weight",
            description:
                "Fix a weight entry that was logged incorrectly. Provide either the entry ID or the date of the entry to update.",
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                new_weight_lb: z
                    .number()
                    .describe("Corrected weight in pounds"),
                id: z
                    .string()
                    .optional()
                    .describe("UUID of the weight entry to update"),
                date: z
                    .string()
                    .optional()
                    .describe(
                        "Date of the entry to update (YYYY-MM-DD). Used when id is not provided.",
                    ),
            },
        },
        async ({ new_weight_lb, id, date }) => {
            return withAnalytics(
                "update_weight",
                async () => {
                    const entry = await updateWeight(
                        userId,
                        new_weight_lb,
                        id,
                        date,
                    );
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Weight entry updated:\n${formatWeightEntry(entry)}`,
                            },
                        ],
                    };
                },
                { userId },
            );
        },
    );

    server.registerTool(
        "delete_weight",
        {
            title: "Delete Weight",
            description:
                "Remove an accidental or duplicate weight entry. Provide either the entry ID or the date.",
            annotations: {
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                id: z
                    .string()
                    .optional()
                    .describe("UUID of the weight entry to delete"),
                date: z
                    .string()
                    .optional()
                    .describe(
                        "Date of the entry to delete (YYYY-MM-DD). Deletes all entries for that date when id is not provided.",
                    ),
            },
        },
        async ({ id, date }) => {
            return withAnalytics(
                "delete_weight",
                async () => {
                    await deleteWeight(userId, id, date);
                    const label = id ?? date ?? "entry";
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Weight entry ${label} deleted.`,
                            },
                        ],
                    };
                },
                { userId },
            );
        },
    );

    // ---------- Hydration tracking tools ----------

    server.registerTool(
        "log_water",
        {
            title: "Log Water",
            description:
                "Log a water intake entry in fluid ounces to track daily hydration.",
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: false,
            },
            inputSchema: {
                amount_fl_oz: z
                    .number()
                    .describe("Amount of water consumed in fluid ounces"),
                date: z
                    .string()
                    .optional()
                    .describe(
                        "Date to log the intake for (YYYY-MM-DD, defaults to today). Ask the user if today's date is unknown.",
                    ),
                timezone: z
                    .string()
                    .optional()
                    .describe(
                        "IANA timezone string (e.g. 'America/New_York'). Used to determine today's date when date is not provided.",
                    ),
            },
        },
        async ({ amount_fl_oz, date, timezone }) => {
            return withAnalytics(
                "log_water",
                async () => {
                    const dateVal = date ?? todayDate(timezone);
                    await insertWater(userId, amount_fl_oz, dateVal);
                    const total = await getWaterToday(userId, dateVal);
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Logged ${amount_fl_oz} fl oz. Total for ${dateVal}: ${total} fl oz.`,
                            },
                        ],
                    };
                },
                { userId },
            );
        },
    );

    server.registerTool(
        "get_water_today",
        {
            title: "Get Water Today",
            description:
                "Get total water intake for the current day (or a specified date) in fluid ounces.",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                date: z
                    .string()
                    .optional()
                    .describe("Date to check (YYYY-MM-DD, defaults to today)."),
                timezone: z
                    .string()
                    .optional()
                    .describe(
                        "IANA timezone string (e.g. 'America/New_York'). Used to determine today's date when date is not provided.",
                    ),
            },
        },
        async ({ date, timezone }) => {
            return withAnalytics(
                "get_water_today",
                async () => {
                    const dateVal = date ?? todayDate(timezone);
                    const total = await getWaterToday(userId, dateVal);
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Water intake for ${dateVal}: ${total} fl oz`,
                            },
                        ],
                    };
                },
                { userId },
            );
        },
    );

    // ---------- Historical search ----------

    server.registerTool(
        "search_meals",
        {
            title: "Search Meals",
            description:
                "Search all past meal descriptions and notes by keyword. Returns matching entries with macros, dates, and notes.",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
            inputSchema: {
                query: z
                    .string()
                    .describe(
                        "Search term to match against meal descriptions and notes (e.g. 'pizza', 'goldfish')",
                    ),
            },
        },
        async ({ query }) => {
            return withAnalytics(
                "search_meals",
                async () => {
                    const meals = await searchMeals(userId, query);
                    if (meals.length === 0) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `No meals found matching "${query}".`,
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
            version: "1.8.0",
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
