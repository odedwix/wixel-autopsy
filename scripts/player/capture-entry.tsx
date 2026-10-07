// Frame-exact capture of the product's own player, for saving the "Exact" composition (text
// overlays, captions, music) as an mp4 when a run has no render. Built by build-player.sh with
// wixel-video-player's own iframe bundle config (same shims and aliases), into
// .cache/vendor/capture-bootstrap.js; driven by server/exact.js through web/player/capture.html.
//
// window.AutopsyCapture.mount(el, input) → { fps, frames, width, height }
// window.AutopsyCapture.seek(frame)      → resolves once every video, image and font is painted
//
// The same bundle also drives the run view's Exact player (web/player/live.html), which Autopsy
// loads hidden while the regular copy plays, then seeks and starts once every file is in memory:
// window.AutopsyLive.mount(el, input, { controls }) → { fps, frames, width, height, player, unmount }
//   (`player` is the Remotion PlayerRef: play, pause, seekTo, getCurrentFrame, isPlaying, mute…)
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import { createRoot } from 'react-dom/client';
import * as WixGizaEssentials from '@wix/fe-essentials-giza';
import { WixelVideoPlayer } from '@wixel-player-src/WixelVideoPlayer';
import { buildCompositionConfig } from '@wixel-player-src/buildCompositionConfig';

const w = window as any;
// The federated remotes read these off window (yoshi externals), as in iframe-bootstrap.tsx.
w.React = React;
w.ReactDOM = ReactDOM;
w.WixGizaEssentials = WixGizaEssentials;

let player: any = null;

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r(null)));

// Settled = no <video> seeking and each has a decoded frame, images loaded, fonts ready, and the
// frame's DOM unchanged for a moment (a component can mount its media a beat after the seek, e.g. a
// story page's image).
async function settled(timeoutMs = 10000) {
  await nextFrame();
  await nextFrame();
  const t0 = performance.now();
  let last = '';
  let same = 0;
  for (;;) {
    const vids = Array.from(document.querySelectorAll('video'));
    const imgs = Array.from(document.querySelectorAll('img'));
    const ok = vids.every((v) => !v.seeking && v.readyState >= 2) && imgs.every((i) => i.complete);
    const sig = `${vids.length}|${imgs.map((i) => i.currentSrc).join(',')}|${document.body.innerHTML.length}`;
    same = sig === last ? same + 1 : 0;
    last = sig;
    if ((ok && same >= 2) || performance.now() - t0 > timeoutMs) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  await (document as any).fonts?.ready;
  await nextFrame();
  await nextFrame();
}

w.AutopsyCapture = {
  async mount(el: HTMLElement, input: any) {
    const config = buildCompositionConfig(input);
    await new Promise<void>((resolve, reject) => {
      const setRef = (r: any) => {
        if (r && !player) {
          player = r;
          resolve();
        }
      };
      createRoot(el).render(React.createElement(WixelVideoPlayer as any, {
        input,
        ref: setRef,
        controls: false,
        autoPlay: false,
        loop: false,
        bundleServerBaseUrl: '',
        prefetchPolicy: 'all',
        style: { width: '100%', height: '100%' },
        onError: (e: Error) => reject(e),
      }));
    });
    player.pause();
    player.mute?.();
    await settled();
    return { fps: config.fps, frames: config.durationInFrames, width: config.width, height: config.height };
  },
  async seek(frame: number) {
    player.seekTo(frame);
    await settled();
    return player.getCurrentFrame();
  },
};

w.AutopsyLive = {
  // Resolves once the player has mounted, which the product player does only after its remote
  // bundles and (prefetchPolicy 'all') every media file are loaded, so playback never stalls.
  async mount(el: HTMLElement, input: any, opts: { controls?: boolean } = {}) {
    const config = buildCompositionConfig(input);
    const root = createRoot(el);
    let ref: any = null;
    await new Promise<void>((resolve, reject) => {
      const setRef = (r: any) => {
        if (r && !ref) {
          ref = r;
          resolve();
        }
      };
      root.render(React.createElement(WixelVideoPlayer as any, {
        input,
        ref: setRef,
        controls: opts.controls !== false,
        autoPlay: false,
        loop: false,
        bundleServerBaseUrl: '',
        prefetchPolicy: 'all',
        style: { width: '100%', height: '100%' },
        onError: (e: Error) => reject(e),
      }));
    });
    ref.pause();
    // The first frame's media decoded, so the switch never shows a black frame.
    await settled(4000);
    return {
      fps: config.fps,
      frames: config.durationInFrames,
      width: config.width,
      height: config.height,
      player: ref,
      unmount: () => root.unmount(),
    };
  },
};
