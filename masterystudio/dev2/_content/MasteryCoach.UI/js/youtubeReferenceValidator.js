// This accepts only an already parsed id; pasted URLs never become iframe sources. It shares the
// production loader so validation and playback never inject competing IFrame API script tags.
import { loadApiOnce } from './youtubePlayer.js';
export async function validate(videoId) {
  let player;
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-10000px;top:-10000px;width:200px;height:200px;overflow:hidden';
  document.body.appendChild(host);
  try {
    const YT = await loadApiOnce();
    return await new Promise((resolve) => {
      const timeout = setTimeout(() => resolve({ isEmbeddable:false, durationSeconds:null, playbackRates:null, failureReason:'The YouTube player did not become ready before validation timed out.' }), 15000);
      player = new YT.Player(host, { width:'200', height:'200', videoId, playerVars:{ playsinline:1 }, events:{
        onReady: () => { clearTimeout(timeout); const duration = player.getDuration(); resolve({ isEmbeddable:true, durationSeconds:Number.isFinite(duration) && duration > 0 ? duration : null, playbackRates:player.getAvailablePlaybackRates(), failureReason:null }); },
        onError: event => { clearTimeout(timeout); resolve({ isEmbeddable:false, durationSeconds:null, playbackRates:null, failureReason:`The official YouTube player rejected this video (error ${event.data}).` }); }
      }});
    });
  } catch (error) { return { isEmbeddable:false, durationSeconds:null, playbackRates:null, failureReason:`YouTube validation failed: ${error.message}` }; }
  finally { player?.destroy(); host.remove(); }
}
