import type { SqlClient } from "effect/unstable/sql/SqlClient";
import type { Fragment } from "effect/unstable/sql/Statement";

/** Strict slash-delimited descendants. Equality and the empty-root policy belong to the caller. */
export const isDescendant = (sql: SqlClient, child: Fragment, ancestor: Fragment) =>
	sql`substr(${child},1,length(${ancestor})+1)=${ancestor}||'/'`;
