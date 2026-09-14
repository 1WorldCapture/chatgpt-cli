// Chat reference normalization.
//
// Normalize a chat reference (full URL / URL path / bare uuid) to a canonical
// path. Pure module — no CDP involved.

export function normalizeChatRef(ref: string): string {
  let path;
  if (/^https?:\/\//.test(ref)) path = new URL(ref).pathname;
  else if (ref.startsWith('/')) path = ref;
  else if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(ref)) path = '/c/' + ref;
  else throw new Error(`unrecognized chat reference: ${ref} (want URL, /c/<uuid>, or <uuid>)`);
  return path.split('?')[0];
}
