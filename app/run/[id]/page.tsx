import { RunView } from "@/components/RunView";

/** Generation + After live theater for a single run (PRD §0c, screens 2–3). */
export default async function RunPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <RunView runId={id} />;
}
