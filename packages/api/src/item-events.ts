/**
 * What happens after an item is created, whoever created it: a person in the
 * app or over MCP (items.create), or an approved agent proposal
 * (agent.approve). One place, so both paths behave the same. Called after
 * the transaction committed; never throws for a side effect.
 */

export async function afterItemCreated(
  organizationId: string,
  itemId: string,
): Promise<void> {
}
