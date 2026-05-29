import type { CastOrigin, SharedBundleManifest } from '@manta/skill-validator';

/**
 * README auto-generation for `manta share` bundles (Phase 7b Task 2.3).
 *
 * Pure: markdown in → markdown out. The `$EDITOR` pass that lets an author
 * tweak the result before publish is the command's job (Task 2.4); this
 * generator only consumes SANITIZED inputs, so no leak can bleed into the
 * README. Deterministic — same input always yields the same output.
 *
 * Seven sections (research §1.6): Overview / What this mode does /
 * Cast lineage / Compat / Installation / Author / License.
 */

export interface ReadmeInput {
  manifest: SharedBundleManifest;
  castOrigin: CastOrigin;
  /** Sanitized post-mortem markdown (used for the "what it does" summary). */
  sanitizedPostMortem: string;
  /** First paragraph of each sanitized ZK note. */
  sanitizedZkFirstParagraphs: string[];
  diffStats: { filesChanged: number; insertions: number; deletions: number };
}

/** Extract the first non-empty, non-heading paragraph from a markdown body. */
function firstParagraph(markdown: string): string {
  const blocks = markdown.split(/\n\s*\n/);
  for (const block of blocks) {
    const trimmed = block.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) continue;
    return trimmed.replace(/\s+/g, ' ');
  }
  return '';
}

export function generateReadme(input: ReadmeInput): string {
  const { manifest, castOrigin, diffStats } = input;
  const lines: string[] = [];

  // 1. Overview
  lines.push(`# ${manifest.name}`, '', manifest.description, '');

  // 2. What this mode does
  lines.push('## What this mode does', '');
  const summary = firstParagraph(input.sanitizedPostMortem);
  lines.push(summary.length > 0 ? summary : `Manta cast \`${castOrigin.castId}\` deliverable.`, '');
  if (input.sanitizedZkFirstParagraphs.length > 0) {
    lines.push('Insights captured during the cast:', '');
    for (const para of input.sanitizedZkFirstParagraphs) {
      const clean = para.trim().replace(/\s+/g, ' ');
      if (clean.length > 0) lines.push(`- ${clean}`);
    }
    lines.push('');
  }
  lines.push(
    `Changes: ${diffStats.filesChanged} file(s), +${diffStats.insertions}/-${diffStats.deletions} lines.`,
    '',
  );

  // 3. Cast lineage
  lines.push('## Cast lineage', '');
  lines.push(`- Cast: \`${castOrigin.castId}\``);
  lines.push(`- Mode: \`${castOrigin.castMode}\``);
  lines.push(`- Winning clone: \`${castOrigin.winningCloneId}\``);
  lines.push(`- Bundled at: ${castOrigin.bundledAt}`);
  if (castOrigin.provenance !== null) {
    lines.push(`- Triggered by: \`${castOrigin.provenance.triggerName}\``);
  }
  lines.push('');

  // 4. Compat
  lines.push('## Compatibility', '');
  lines.push(`Requires a Manta runtime matching \`${manifest.mantaVersionCompat}\`.`, '');

  // 5. Installation
  lines.push('## Installation', '');
  lines.push('```sh', `manta install ${manifest.name}@${manifest.version}`, '```', '');

  // 6. Author
  lines.push('## Author', '', manifest.author, '');

  // 7. License
  lines.push('## License', '', manifest.license, '');

  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}
