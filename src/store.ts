import type { SessionStore, UserSession } from "./types.js";

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, UserSession>();
  private key(userId: string, conversationId: string) { return `${userId}:${conversationId}`; }
  async get(userId: string, conversationId: string): Promise<UserSession | undefined> { return this.sessions.get(this.key(userId, conversationId)); }
  async put(session: UserSession): Promise<void> { this.sessions.set(this.key(session.userId, session.conversationId), session); }
  async delete(userId: string, conversationId: string): Promise<void> { this.sessions.delete(this.key(userId, conversationId)); }
}
