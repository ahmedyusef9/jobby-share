import { Suspense } from "react";
import { pipelineSummary } from "@/lib/career-ops";
import { PipelineView } from "@/components/pipeline-view";
import { withTenantPage } from "@/lib/tenant/http";

export const dynamic = "force-dynamic"; // always read fresh local files

export default async function PipelinePage() {
  return withTenantPage(() => {
    const { inbox, applications, reportUrls } = pipelineSummary();
    return (
      <Suspense>
        <PipelineView applications={applications} inbox={inbox} reportUrls={reportUrls} />
      </Suspense>
    );
  });
}
