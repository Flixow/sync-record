// Export presets. Video presets follow YouTube's upload recommendations for SDR H.264 + AAC in MP4.

export interface VideoPreset {
  kind: "video";
  id: string;
  label: string;
  width: number;
  height: number;
  fps: number;
  /** Target video bitrate in bit/s and the range an export must land in. */
  videoBitrate: number;
  minVideoBitrate: number;
  maxVideoBitrate: number;
  audioBitrate: number;
  container: "mp4";
  extension: "mp4";
}

export interface AudioPreset {
  kind: "audio";
  id: string;
  label: string;
  codec: "mp3" | "wav";
  extension: "mp3" | "wav";
  bitrate: number | null;
}

export type Preset = VideoPreset | AudioPreset;

const video = (id: string, label: string, width: number, height: number, fps: number, mbps: number, min: number, max: number): VideoPreset => ({
  kind: "video",
  id,
  label,
  width,
  height,
  fps,
  videoBitrate: mbps * 1_000_000,
  minVideoBitrate: min * 1_000_000,
  maxVideoBitrate: max * 1_000_000,
  audioBitrate: 384_000,
  container: "mp4",
  extension: "mp4",
});

/** The picture shape of a video preset. */
export const presetAspect = (preset: VideoPreset): "16:9" | "9:16" | "1:1" => (preset.height > preset.width ? "9:16" : preset.height === preset.width ? "1:1" : "16:9");

export const PRESETS: Preset[] = [
  video("youtube-1080p30", "YouTube 1080p30", 1920, 1080, 30, 8, 6, 10),
  video("youtube-1080p60", "YouTube 1080p60", 1920, 1080, 60, 12, 9, 15),
  video("youtube-2160p30", "YouTube 4K 30", 3840, 2160, 30, 40, 35, 45),
  video("youtube-2160p60", "YouTube 4K 60", 3840, 2160, 60, 60, 53, 68),
  video("vertical-1080p30", "Vertical 9:16 1080x1920 (Shorts, Reels)", 1080, 1920, 30, 8, 5, 10),
  video("square-1080p30", "Square 1:1 1080x1080", 1080, 1080, 30, 6, 4, 8),
  { kind: "audio", id: "audio-mp3", label: "Audio MP3 192 kbit/s", codec: "mp3", extension: "mp3", bitrate: 192_000 },
  { kind: "audio", id: "audio-wav", label: "Audio WAV 48 kHz", codec: "wav", extension: "wav", bitrate: null },
];

export function presetById(id: string): Preset | null {
  return PRESETS.find((preset) => preset.id === id) ?? null;
}

/** Group of pictures: closed, half a second long (YouTube's recommendation). */
export const gopFrames = (fps: number): number => Math.max(1, Math.round(fps / 2));
