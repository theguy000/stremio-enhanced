import SeriesInfo from "./SeriesInfo";
import MetaDetails from "./MetaDetails";
import { MpvSubtitleTrack } from "./MpvTypes";

interface PlayerState {
    seriesInfoDetails: SeriesInfo | null;
    metaDetails: MetaDetails;
    stream?: { content: { url: string } };
    subtitlesTracks?: MpvSubtitleTrack[];
}

export default PlayerState;