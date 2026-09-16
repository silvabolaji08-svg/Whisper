import { redirect } from "next/navigation";

import ChatRoom from "@/components/ChatRoom";
import { normalizeRoom } from "@/lib/types";

export default async function RoomPage({
  params,
}: {
  params: Promise<{ room: string }>;
}) {
  const { room } = await params;
  const slug = normalizeRoom(decodeURIComponent(room));

  // Send anything that is not already a clean slug back through the join screen
  // (or to its normalized form) so one room never splits across two URLs.
  if (!slug) redirect("/");
  if (slug !== room) redirect(`/r/${slug}`);

  return <ChatRoom room={slug} />;
}
