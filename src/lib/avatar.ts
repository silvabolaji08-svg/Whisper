// Fixed palette so a given name always renders with the same colour for everyone.
const AVATAR_CLASSES = [
  "bg-rose-500",
  "bg-orange-500",
  "bg-amber-500",
  "bg-lime-500",
  "bg-emerald-500",
  "bg-teal-500",
  "bg-sky-500",
  "bg-indigo-500",
  "bg-violet-500",
  "bg-fuchsia-500",
];

function hash(value: string): number {
  let result = 0;
  for (let i = 0; i < value.length; i += 1) {
    result = (result * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(result);
}

export function avatarClass(username: string): string {
  return AVATAR_CLASSES[hash(username) % AVATAR_CLASSES.length];
}

/** First character of the name, uppercased, for use inside the avatar circle. */
export function initial(username: string): string {
  return [...username][0]?.toUpperCase() ?? "?";
}
