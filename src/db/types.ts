export interface QueryResult<Row> {
  readonly rows: Row[];
}

/** The subset of a SQL connection the application needs. */
export interface Queryable {
  /** Runs one parameterized statement. */
  query<Row = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
  /** Runs a script of one or more statements with no parameters. */
  exec(sql: string): Promise<void>;
}

export interface Database extends Queryable {
  /**
   * Runs `fn` inside a transaction on a single connection. Commits when it
   * resolves, rolls back when it throws.
   */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
