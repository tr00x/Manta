export const POST_MORTEM_METADATA_ALLOWLIST = Object.freeze([
  'cast_id',
  'cast_mode',
] as const) satisfies readonly string[];

export type AllowlistedMetadataKey = (typeof POST_MORTEM_METADATA_ALLOWLIST)[number];

export type SanitizedMetadata = Readonly<Partial<Record<AllowlistedMetadataKey, string>>>;

export interface RedactPostMortemMetadataResult {
  kept: SanitizedMetadata;
  dropped: string[];
}

const ALLOWLIST_SET: ReadonlySet<string> = new Set<string>(POST_MORTEM_METADATA_ALLOWLIST);

export function redactPostMortemMetadata(
  meta: Readonly<Record<string, string>>,
): RedactPostMortemMetadataResult {
  const kept: Record<string, string> = {};
  const dropped: string[] = [];
  for (const key of Object.keys(meta)) {
    if (ALLOWLIST_SET.has(key)) {
      kept[key] = meta[key];
    } else {
      dropped.push(key);
    }
  }
  dropped.sort();
  return { kept: kept as SanitizedMetadata, dropped };
}
