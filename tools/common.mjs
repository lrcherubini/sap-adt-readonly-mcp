// What the tools built in tools/index.mjs share: the answer as text, and the gap filed for a
// type the contract of lib/type-contract.mjs never decided.

/** One text block: a string as it is, anything else as compact JSON. */
export const asText = (value) => ({
  content: [
    {
      type: 'text',
      text: typeof value === 'string' ? value : JSON.stringify(value),
    },
  ],
});

/** The gap filed when a tool answers a type on the generic path, for want of a contract entry. */
export const typeNotInContractGap = (journal) => (hit, tool) =>
  journal?.gap?.({
    code: 'TYPE_NOT_IN_CONTRACT',
    subject: String(hit['adtcore:type'] ?? '?'),
    detail: `${tool} on ${hit['adtcore:name']}: this type has no entry in lib/type-contract.mjs`,
    impact: 'answered on the generic path, without a field list; what this tool answers for the type was never measured',
    fallback: 'measure one object of the type (adt_object_info + adt_read_source) and add the entry, with its evidence',
  });
