import { Pool, type QueryResult, type QueryResultRow } from "pg";

export class DatabaseService {
  private readonly pool?: Pool;

  constructor(connectionString?: string) {
    if (connectionString) {
      this.pool = new Pool({
        connectionString
      });
    }
  }

  isConfigured(): boolean {
    return Boolean(this.pool);
  }

  async query<TRow extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[]
  ): Promise<QueryResult<TRow>> {
    if (!this.pool) {
      throw new Error("DATABASE_URL is not configured.");
    }

    return this.pool.query<TRow>(text, values);
  }
}
