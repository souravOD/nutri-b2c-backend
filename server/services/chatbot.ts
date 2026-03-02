import { ragChat } from "./ragClient.js";
import { db } from "../config/database.js";
import { chatSessions } from "../../shared/goldSchema.js";
import { eq, desc, and } from "drizzle-orm";

// ── Types ───────────────────────────────────────────────────────────────────

export interface ChatResponse {
    message: string;
    intent: string;
    sessionId: string | null;
    actionRequired: boolean;
    confirmationPrompt?: string;
    recipes?: { id: string; title: string; score?: number }[];
    nutritionData?: any;
}

// ── Process Message ─────────────────────────────────────────────────────────

export async function processMessage(
    customerId: string,
    message: string,
    sessionId?: string
): Promise<ChatResponse> {
    // Try RAG chatbot
    const ragResponse = await ragChat(message, customerId, sessionId ?? null);

    if (ragResponse) {
        // Update session in PG
        if (ragResponse.session_id) {
            await updateSession(customerId, ragResponse.session_id, {
                lastIntent: ragResponse.intent,
                messageCount: ragResponse.message_count ?? 1,
            });
        }

        return {
            message: ragResponse.response,
            intent: ragResponse.intent,
            sessionId: ragResponse.session_id ?? null,
            actionRequired: ragResponse.action_required || false,
            confirmationPrompt: ragResponse.confirmation_prompt,
            recipes: ragResponse.recipes || [],
            nutritionData: (ragResponse as any).nutrition_data,
        };
    }

    // Chatbot unavailable fallback
    return {
        message:
            "I'm temporarily unavailable. Please try again in a few minutes. You can still search for recipes and manage your meal plans using the regular app features.",
        intent: "unavailable",
        sessionId: null,
        actionRequired: false,
    };
}

// ── Session Management ──────────────────────────────────────────────────────

async function updateSession(
    customerId: string,
    sessionId: string,
    meta: { lastIntent: string; messageCount: number }
) {
    const existing = await db
        .select()
        .from(chatSessions)
        .where(eq(chatSessions.id, sessionId))
        .limit(1);

    const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 min TTL

    if (existing[0]) {
        await db
            .update(chatSessions)
            .set({
                sessionData: {
                    ...(existing[0].sessionData as any),
                    lastIntent: meta.lastIntent,
                    messageCount: meta.messageCount,
                },
                expiresAt,
            })
            .where(eq(chatSessions.id, sessionId));
    } else {
        await db.insert(chatSessions).values({
            id: sessionId,
            b2cCustomerId: customerId,
            sessionData: {
                lastIntent: meta.lastIntent,
                messageCount: meta.messageCount,
            },
            expiresAt,
        });
    }
}

export async function getRecentSessions(customerId: string, limit: number) {
    return db
        .select()
        .from(chatSessions)
        .where(eq(chatSessions.b2cCustomerId, customerId))
        .orderBy(desc(chatSessions.createdAt))
        .limit(limit);
}
