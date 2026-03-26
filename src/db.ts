// ---------- Timezone helpers ----------

/**
 * Returns the UTC offset string (e.g. "+05:30", "-04:00") for a given
 * IANA timezone at the current moment.
 */
function getUtcOffsetString(timezone: string): string {
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
    const hour = get("hour") === "24" ? "00" : get("hour");
    const minute = get("minute");
    const second = get("second");

    const localAsIfUtc = new Date(
        `${year}-${month}-${day}T${hour}:${minute}:${second}Z`,
    );
    const offsetMs = localAsIfUtc.getTime() - now.getTime();
    const offsetTotalMinutes = Math.round(offsetMs / 60000);
    const sign = offsetTotalMinutes >= 0 ? "+" : "-";
    const absMinutes = Math.abs(offsetTotalMinutes);
    const offsetH = String(Math.floor(absMinutes / 60)).padStart(2, "0");
    const offsetM = String(absMinutes % 60).padStart(2, "0");

    return `${sign}${offsetH}:${offsetM}`;
}

/**
 * Returns a timezone-aware ISO 8601 timestamp for "now" in the given
 * IANA timezone (e.g. "2026-03-24T20:09:00-04:00"). Falls back to UTC
 * ISO string when no timezone is provided.
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
    const hour = get("hour") === "24" ? "00" : get("hour");
    const minute = get("minute");
    const second = get("second");

    const offset = getUtcOffsetString(timezone);
    return `${year}-${month}-${day}T${hour}:${minute}:${second}${offset}`;
}

// ---------- Auth ----------

export async function signUpUser(
    email: string,
    password: string,
): Promise<string> {
    const existing = await Bun.sql`SELECT id FROM users WHERE email = ${email}`;
    if (existing.length > 0) {
        throw new Error("An account with that email already exists");
    }

    const passwordHash = await Bun.password.hash(password);
    const rows =
        await Bun.sql`INSERT INTO users (email, password_hash) VALUES (${email}, ${passwordHash}) RETURNING id`;

    if (rows.length === 0) throw new Error("Sign-up failed");
    return rows[0].id as string;
}

export async function signInUser(
    email: string,
    password: string,
): Promise<string> {
    const rows =
        await Bun.sql`SELECT id, password_hash FROM users WHERE email = ${email}`;

    if (rows.length === 0) {
        throw new Error("Invalid email or password");
    }

    const user = rows[0];
    const valid = await Bun.password.verify(
        password,
        user.password_hash as string,
    );
    if (!valid) {
        throw new Error("Invalid email or password");
    }

    return user.id as string;
}

// ---------- Meals ----------

export interface Meal {
    id: string;
    user_id: string;
    logged_at: string;
    meal_type: string | null;
    description: string;
    calories: number | null;
    protein_g: number | null;
    carbs_g: number | null;
    fat_g: number | null;
    notes: string | null;
}

export interface MealInput {
    description: string;
    meal_type: "breakfast" | "lunch" | "dinner" | "snack";
    calories?: number;
    protein_g?: number;
    carbs_g?: number;
    fat_g?: number;
    logged_at?: string;
    timezone?: string;
    notes?: string;
}

export async function insertMeal(
    userId: string,
    input: MealInput,
): Promise<Meal> {
    const loggedAt = input.logged_at ?? nowInTimezone(input.timezone);
    const calories = input.calories ?? null;
    const protein_g = input.protein_g ?? null;
    const carbs_g = input.carbs_g ?? null;
    const fat_g = input.fat_g ?? null;
    const notes = input.notes ?? null;
    const meal_type = input.meal_type;

    const rows = await Bun.sql`
        INSERT INTO meals (user_id, description, meal_type, calories, protein_g, carbs_g, fat_g, logged_at, notes)
        VALUES (${userId}, ${input.description}, ${meal_type}, ${calories}, ${protein_g}, ${carbs_g}, ${fat_g}, ${loggedAt}, ${notes})
        RETURNING *
    `;

    if (rows.length === 0) throw new Error("Failed to insert meal");
    return rows[0] as Meal;
}

export async function getMealsByDate(
    userId: string,
    date: string,
    timezone?: string,
): Promise<Meal[]> {
    const offset = timezone ? getUtcOffsetString(timezone) : "";
    const startOfDay = `${date}T00:00:00${offset}`;
    const endOfDay = `${date}T23:59:59${offset}`;

    const rows = await Bun.sql`
        SELECT * FROM meals
        WHERE user_id = ${userId}
          AND logged_at >= ${startOfDay}::timestamptz
          AND logged_at <= ${endOfDay}::timestamptz
        ORDER BY logged_at ASC
    `;

    return rows as Meal[];
}

export async function getMealsInRange(
    userId: string,
    startDate: string,
    endDate: string,
    timezone?: string,
): Promise<Meal[]> {
    const offset = timezone ? getUtcOffsetString(timezone) : "";
    const start = `${startDate}T00:00:00${offset}`;
    const end = `${endDate}T23:59:59${offset}`;

    const rows = await Bun.sql`
        SELECT * FROM meals
        WHERE user_id = ${userId}
          AND logged_at >= ${start}::timestamptz
          AND logged_at <= ${end}::timestamptz
        ORDER BY logged_at ASC
    `;

    return rows as Meal[];
}

export async function deleteMeal(userId: string, id: string): Promise<void> {
    await Bun.sql`DELETE FROM meals WHERE id = ${id} AND user_id = ${userId}`;
}

export async function updateMeal(
    userId: string,
    id: string,
    fields: Partial<MealInput>,
): Promise<Meal> {
    // Fetch current values so we can apply partial updates safely
    const existing =
        await Bun.sql`SELECT * FROM meals WHERE id = ${id} AND user_id = ${userId}`;
    if (existing.length === 0) throw new Error("Meal not found");

    const cur = existing[0] as Meal;
    const description =
        fields.description !== undefined ? fields.description : cur.description;
    const meal_type =
        fields.meal_type !== undefined ? fields.meal_type : cur.meal_type;
    const calories =
        fields.calories !== undefined ? fields.calories : cur.calories;
    const protein_g =
        fields.protein_g !== undefined ? fields.protein_g : cur.protein_g;
    const carbs_g = fields.carbs_g !== undefined ? fields.carbs_g : cur.carbs_g;
    const fat_g = fields.fat_g !== undefined ? fields.fat_g : cur.fat_g;
    const logged_at =
        fields.logged_at !== undefined ? fields.logged_at : cur.logged_at;
    const notes = fields.notes !== undefined ? fields.notes : cur.notes;

    const rows = await Bun.sql`
        UPDATE meals
        SET description = ${description},
            meal_type   = ${meal_type},
            calories    = ${calories},
            protein_g   = ${protein_g},
            carbs_g     = ${carbs_g},
            fat_g       = ${fat_g},
            logged_at   = ${logged_at}::timestamptz,
            notes       = ${notes}
        WHERE id = ${id} AND user_id = ${userId}
        RETURNING *
    `;

    if (rows.length === 0) throw new Error("Failed to update meal");
    return rows[0] as Meal;
}

// ---------- Recipes ----------

export interface ScaledMacros {
    calories: number | null;
    protein_g: number | null;
    carbs_g: number | null;
    fat_g: number | null;
}

/**
 * Returns per-serving macros from a recipe multiplied by servings.
 * Fields that have no value on the recipe are returned as null.
 */
export function calculateScaledMacros(
    recipe: Recipe,
    servings: number,
): ScaledMacros {
    return {
        calories:
            recipe.calories_per_serving != null
                ? (recipe.calories_per_serving as number) * servings
                : null,
        protein_g:
            recipe.protein_g_per_serving != null
                ? (recipe.protein_g_per_serving as number) * servings
                : null,
        carbs_g:
            recipe.carbs_g_per_serving != null
                ? (recipe.carbs_g_per_serving as number) * servings
                : null,
        fat_g:
            recipe.fat_g_per_serving != null
                ? (recipe.fat_g_per_serving as number) * servings
                : null,
    };
}

export interface Recipe {
    id: string;
    user_id: string;
    name: string;
    description: string | null;
    ingredients: string[];
    steps: string[];
    tags: string[];
    servings: number;
    calories_per_serving: number | null;
    protein_g_per_serving: number | null;
    carbs_g_per_serving: number | null;
    fat_g_per_serving: number | null;
    created_at: string;
    updated_at: string;
}

export interface RecipeInput {
    name: string;
    description?: string;
    ingredients?: string[];
    steps?: string[];
    tags?: string[];
    servings?: number;
    calories_per_serving?: number;
    protein_g_per_serving?: number;
    carbs_g_per_serving?: number;
    fat_g_per_serving?: number;
}

export async function insertRecipe(
    userId: string,
    input: RecipeInput,
): Promise<Recipe> {
    const description = input.description ?? null;
    const ingredients = JSON.stringify(input.ingredients ?? []);
    const steps = JSON.stringify(input.steps ?? []);
    const tags = JSON.stringify(input.tags ?? []);
    const servings = input.servings ?? 1;
    const calories_per_serving = input.calories_per_serving ?? null;
    const protein_g_per_serving = input.protein_g_per_serving ?? null;
    const carbs_g_per_serving = input.carbs_g_per_serving ?? null;
    const fat_g_per_serving = input.fat_g_per_serving ?? null;

    const rows = await Bun.sql`
        INSERT INTO recipes (user_id, name, description, ingredients, steps, tags, servings, calories_per_serving, protein_g_per_serving, carbs_g_per_serving, fat_g_per_serving)
        VALUES (${userId}, ${input.name}, ${description}, ${ingredients}::jsonb, ${steps}::jsonb, ${tags}::jsonb, ${servings}, ${calories_per_serving}, ${protein_g_per_serving}, ${carbs_g_per_serving}, ${fat_g_per_serving})
        RETURNING *
    `;

    if (rows.length === 0) throw new Error("Failed to insert recipe");
    return rows[0] as Recipe;
}

export async function getRecipes(
    userId: string,
    tag?: string,
): Promise<Recipe[]> {
    const rows = tag
        ? await Bun.sql`
            SELECT * FROM recipes
            WHERE user_id = ${userId}
              AND tags @> ${JSON.stringify([tag])}::jsonb
            ORDER BY name ASC
          `
        : await Bun.sql`
            SELECT * FROM recipes
            WHERE user_id = ${userId}
            ORDER BY name ASC
          `;

    return rows as Recipe[];
}

export async function getRecipeById(
    userId: string,
    id: string,
): Promise<Recipe | null> {
    const rows =
        await Bun.sql`SELECT * FROM recipes WHERE id = ${id} AND user_id = ${userId}`;
    if (rows.length === 0) return null;
    return rows[0] as Recipe;
}

export async function updateRecipe(
    userId: string,
    id: string,
    fields: Partial<RecipeInput>,
): Promise<Recipe> {
    const existing =
        await Bun.sql`SELECT * FROM recipes WHERE id = ${id} AND user_id = ${userId}`;
    if (existing.length === 0) throw new Error("Recipe not found");

    const cur = existing[0] as Recipe;
    const name = fields.name !== undefined ? fields.name : cur.name;
    const description =
        fields.description !== undefined ? fields.description : cur.description;
    const ingredients = JSON.stringify(
        fields.ingredients !== undefined ? fields.ingredients : cur.ingredients,
    );
    const steps = JSON.stringify(
        fields.steps !== undefined ? fields.steps : cur.steps,
    );
    const tags = JSON.stringify(
        fields.tags !== undefined ? fields.tags : cur.tags,
    );
    const servings =
        fields.servings !== undefined ? fields.servings : cur.servings;
    const calories_per_serving =
        fields.calories_per_serving !== undefined
            ? fields.calories_per_serving
            : cur.calories_per_serving;
    const protein_g_per_serving =
        fields.protein_g_per_serving !== undefined
            ? fields.protein_g_per_serving
            : cur.protein_g_per_serving;
    const carbs_g_per_serving =
        fields.carbs_g_per_serving !== undefined
            ? fields.carbs_g_per_serving
            : cur.carbs_g_per_serving;
    const fat_g_per_serving =
        fields.fat_g_per_serving !== undefined
            ? fields.fat_g_per_serving
            : cur.fat_g_per_serving;

    const rows = await Bun.sql`
        UPDATE recipes
        SET name                  = ${name},
            description           = ${description},
            ingredients           = ${ingredients}::jsonb,
            steps                 = ${steps}::jsonb,
            tags                  = ${tags}::jsonb,
            servings              = ${servings},
            calories_per_serving  = ${calories_per_serving},
            protein_g_per_serving = ${protein_g_per_serving},
            carbs_g_per_serving   = ${carbs_g_per_serving},
            fat_g_per_serving     = ${fat_g_per_serving},
            updated_at            = now()
        WHERE id = ${id} AND user_id = ${userId}
        RETURNING *
    `;

    if (rows.length === 0) throw new Error("Failed to update recipe");
    return rows[0] as Recipe;
}

export async function deleteRecipe(userId: string, id: string): Promise<void> {
    await Bun.sql`DELETE FROM recipes WHERE id = ${id} AND user_id = ${userId}`;
}

// ---------- Meal plan ----------

export interface MealPlan {
    id: string;
    user_id: string;
    date: string;
    slot: "breakfast" | "lunch" | "dinner" | "snack";
    recipe_id: string | null;
    servings: number;
    custom_description: string | null;
    calories: number | null;
    protein_g: number | null;
    carbs_g: number | null;
    fat_g: number | null;
    notes: string | null;
    created_at: string;
}

export interface MealPlanInput {
    date: string;
    slot: "breakfast" | "lunch" | "dinner" | "snack";
    recipe_id?: string;
    servings?: number;
    custom_description?: string;
    calories?: number;
    protein_g?: number;
    carbs_g?: number;
    fat_g?: number;
    notes?: string;
}

export async function insertMealPlan(
    userId: string,
    input: MealPlanInput,
): Promise<MealPlan> {
    const recipe_id = input.recipe_id ?? null;
    const servings = input.servings ?? 1;
    const custom_description = input.custom_description ?? null;
    const notes = input.notes ?? null;

    let calories = input.calories ?? null;
    let protein_g = input.protein_g ?? null;
    let carbs_g = input.carbs_g ?? null;
    let fat_g = input.fat_g ?? null;

    // Auto-fill macros from linked recipe when not explicitly provided
    if (
        recipe_id &&
        (calories === null ||
            protein_g === null ||
            carbs_g === null ||
            fat_g === null)
    ) {
        const recipeRows =
            await Bun.sql`SELECT * FROM recipes WHERE id = ${recipe_id} AND user_id = ${userId}`;
        if (recipeRows.length > 0) {
            const scaled = calculateScaledMacros(
                recipeRows[0] as Recipe,
                servings,
            );
            if (calories === null) calories = scaled.calories;
            if (protein_g === null) protein_g = scaled.protein_g;
            if (carbs_g === null) carbs_g = scaled.carbs_g;
            if (fat_g === null) fat_g = scaled.fat_g;
        }
    }

    const rows = await Bun.sql`
        INSERT INTO meal_plan (user_id, date, slot, recipe_id, servings, custom_description, calories, protein_g, carbs_g, fat_g, notes)
        VALUES (${userId}, ${input.date}, ${input.slot}, ${recipe_id}, ${servings}, ${custom_description}, ${calories}, ${protein_g}, ${carbs_g}, ${fat_g}, ${notes})
        RETURNING *
    `;

    if (rows.length === 0) throw new Error("Failed to insert meal plan");
    return rows[0] as MealPlan;
}

export async function getMealPlanByDate(
    userId: string,
    date: string,
): Promise<MealPlan[]> {
    const rows = await Bun.sql`
        SELECT * FROM meal_plan
        WHERE user_id = ${userId} AND date = ${date}::date
        ORDER BY CASE slot
            WHEN 'breakfast' THEN 1
            WHEN 'lunch' THEN 2
            WHEN 'dinner' THEN 3
            WHEN 'snack' THEN 4
            ELSE 5
        END
    `;
    return rows as MealPlan[];
}

export async function getMealPlanByDateRange(
    userId: string,
    startDate: string,
    endDate: string,
): Promise<MealPlan[]> {
    const rows = await Bun.sql`
        SELECT * FROM meal_plan
        WHERE user_id = ${userId}
          AND date >= ${startDate}::date
          AND date <= ${endDate}::date
        ORDER BY date ASC, CASE slot
            WHEN 'breakfast' THEN 1
            WHEN 'lunch' THEN 2
            WHEN 'dinner' THEN 3
            WHEN 'snack' THEN 4
            ELSE 5
        END
    `;
    return rows as MealPlan[];
}

export async function getMealPlanById(
    userId: string,
    id: string,
): Promise<MealPlan | null> {
    const rows =
        await Bun.sql`SELECT * FROM meal_plan WHERE id = ${id} AND user_id = ${userId}`;
    if (rows.length === 0) return null;
    return rows[0] as MealPlan;
}

export async function deleteMealPlan(
    userId: string,
    id: string,
): Promise<void> {
    await Bun.sql`DELETE FROM meal_plan WHERE id = ${id} AND user_id = ${userId}`;
}

// ---------- Delete all user data ----------

export async function deleteAllUserData(userId: string): Promise<void> {
    // tool_analytics has no FK to users, delete manually
    await Bun.sql`DELETE FROM tool_analytics WHERE user_id = ${userId}`;
    // meal_plan and recipes are cascaded via users FK, but delete explicitly for clarity
    await Bun.sql`DELETE FROM meal_plan WHERE user_id = ${userId}`;
    await Bun.sql`DELETE FROM recipes WHERE user_id = ${userId}`;
    // CASCADE on users FK handles meals, oauth_tokens, auth_codes, refresh_tokens
    const result =
        await Bun.sql`DELETE FROM users WHERE id = ${userId} RETURNING id`;
    if (result.length === 0) throw new Error("User not found");
}

// ---------- OAuth tokens ----------

export async function storeToken(token: string, userId: string): Promise<void> {
    const expiresAt = new Date(
        Date.now() + 365 * 24 * 60 * 60 * 1000,
    ).toISOString();

    await Bun.sql`
        INSERT INTO oauth_tokens (token, user_id, expires_at)
        VALUES (${token}, ${userId}, ${expiresAt})
        ON CONFLICT (token) DO UPDATE SET expires_at = EXCLUDED.expires_at
    `;
}

export async function getUserIdByToken(token: string): Promise<string | null> {
    const rows = await Bun.sql`
        SELECT user_id FROM oauth_tokens
        WHERE token = ${token} AND expires_at > NOW()
    `;

    if (rows.length === 0) return null;
    return rows[0].user_id as string;
}

// ---------- Auth codes ----------

export async function storeAuthCode(
    code: string,
    redirectUri: string,
    userId: string,
    codeChallenge?: string,
): Promise<void> {
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const challenge = codeChallenge ?? null;

    await Bun.sql`
        INSERT INTO auth_codes (code, redirect_uri, user_id, code_challenge, expires_at)
        VALUES (${code}, ${redirectUri}, ${userId}, ${challenge}, ${expiresAt})
    `;
}

export interface AuthCodeData {
    code: string;
    redirect_uri: string;
    user_id: string;
    code_challenge: string | null;
}

export async function consumeAuthCode(
    code: string,
): Promise<AuthCodeData | null> {
    const rows = await Bun.sql`
        DELETE FROM auth_codes
        WHERE code = ${code} AND expires_at > NOW()
        RETURNING code, redirect_uri, user_id, code_challenge
    `;

    if (rows.length === 0) return null;
    return rows[0] as AuthCodeData;
}

// ---------- Refresh tokens ----------

export async function storeRefreshToken(
    token: string,
    userId: string,
): Promise<void> {
    const expiresAt = new Date(
        Date.now() + 365 * 24 * 60 * 60 * 1000,
    ).toISOString();

    await Bun.sql`
        INSERT INTO refresh_tokens (token, user_id, expires_at)
        VALUES (${token}, ${userId}, ${expiresAt})
    `;
}

export async function consumeRefreshToken(
    token: string,
): Promise<string | null> {
    const rows = await Bun.sql`
        DELETE FROM refresh_tokens
        WHERE token = ${token} AND expires_at > NOW()
        RETURNING user_id
    `;

    if (rows.length === 0) return null;
    return rows[0].user_id as string;
}

// ---------- Registered clients ----------

export function registerClient(
    clientName: string | null,
    redirectUris: string[],
): void {
    // Fire-and-forget: log who registers. Failure is non-fatal.
    const urisJson = JSON.stringify(redirectUris);
    Bun.sql`
        INSERT INTO registered_clients (client_name, redirect_uris)
        VALUES (${clientName}, ${urisJson}::jsonb)
    `.catch((err: unknown) => {
        console.warn(
            "Failed to persist client registration:",
            err instanceof Error ? err.message : String(err),
        );
    });
}
