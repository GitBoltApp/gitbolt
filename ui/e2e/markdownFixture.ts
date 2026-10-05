/** A realistic Markdown document of about `bytes` bytes (ASCII): sections with a heading, prose
 * with links, references and inline styles, a task list, a table and a fenced code block. 5A's MR
 * view budget test and 5B's File View one share it. */
export function bigMarkdown(bytes: number): string {
  const parts: string[] = [];
  let size = 0;
  for (let i = 1; size < bytes; i++) {
    const s = `## Section ${i}\n\nThe cache in step ${i} keeps [the index](https://example.org/docs/${i}) warm; see !${(i % 40) + 1} and #${i}, and commit abc${String(i).padStart(4, '0')}d. *Emphasis*, **strong**, \`inline code\` and ~~old~~ text.\n\n- [x] measured\n- [ ] tuned for ${i}\n- plain item\n\n| Step | Time |\n|---|---|\n| ${i} | ${i * 3} ms |\n\n\`\`\`ts\nexport const step${i} = (n: number) => n * ${i};\n\`\`\`\n\n`;
    parts.push(s);
    size += s.length;
  }
  return parts.join('');
}
