/** The avatar store's key: Gravatar's own normalization (trimmed, lowercased). */
export const avatarKey = (email: string) => email.trim().toLowerCase();

/** FNV-1a: a stable colour per person. */
const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};

/** The lane-palette index of a person's initials avatar, picked by the email (the name when
 * there's none). The one colour per person that every avatar uses: the `<Avatar>` component and
 * the graph's commit nodes alike. `lanes`: the palette's length. Dependency-free, so the canvas
 * renderer can use it. */
export const avatarLane = (name: string, email: string, lanes: number) => hash(avatarKey(email) || name) % lanes;
