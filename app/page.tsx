import { Header } from "@/components/Header";
import { Library } from "@/components/Library";
import { BriefComposer } from "@/components/BriefComposer";

/** Setup screen — footage library + the one-screen brief (PRD §0c, screen 1). */
export default function SetupPage() {
  return (
    <main className="mx-auto flex h-screen max-w-[1240px] flex-col px-[26px] pb-[18px] pt-5">
      <Header active="setup" />

      <div className="mb-[14px] flex items-baseline gap-3">
        <h2 className="font-serif text-[24px] font-semibold tracking-[-0.02em] text-ink">
          New cut
        </h2>
        <p className="text-[13px] text-muted">
          You give taste — upload, then a one-screen brief. The agent owns
          everything after.
        </p>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[1.5fr_1fr] gap-5">
        <Library />
        <BriefComposer />
      </div>
    </main>
  );
}
