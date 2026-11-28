import { cardParticipantId, type LayoutSource } from "../../shared/layout.js";
import type { ProjectFile } from "../../shared/project.js";
import type { ProjectApi } from "../lib/project-api.js";
import { t } from "../i18n/index.js";
import type { PreviewSource } from "./layout-preview.js";

/** The pictures the layouts can show, named like the tracks of the recording: a camera by its owner, a screen and a name card with their kind. */
export function sceneSources(api: ProjectApi, project: ProjectFile, layoutSources: LayoutSource[]): PreviewSource[] {
  return layoutSources.map((source) => {
    const cardOf = cardParticipantId(source.id);
    if (source.kind === "card" && cardOf !== null) {
      const name = project.participants.find((participant) => participant.id === cardOf)?.name ?? cardOf;
      return { ...source, name: `${name} · ${t("rec.track.audio")}`, video: null, card: name };
    }
    const own = project.sources.find((item) => item.id === source.id);
    const owner = own ? `${own.participantName}${source.kind === "screen" ? ` · ${t("rec.track.screen")}` : ""}${own.segment > 1 ? ` #${own.segment}` : ""}` : source.id;
    return { ...source, name: owner, video: own?.video ? api.mediaUrl(own.video.file) : null };
  });
}
