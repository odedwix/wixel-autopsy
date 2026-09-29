// Frame-exact capture of the product's own player, for saving the "Exact" composition (text
// overlays, captions, music) as an mp4 when a run has no render. Built by build-player.sh with
// wixel-video-player's own iframe bundle config (same shims and aliases), into
// .cache/vendor/capture-bootstrap.js; driven by server/exact.js through web/player/capture.html.
//
// window.AutopsyCapture.mount(el, input) → { fps, frames, width, height }
// window.AutopsyCapture.seek(frame)      → resolves once every video, image and font is painted
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

// Settled = no <video> seeking and each has a decoded frame, images loaded, fonts ready.
async function settled(timeoutMs = 10000) {
  await nextFrame();
  await nextFrame();
  const t0 = performance.now();
  for (;;) {
    const vids = Array.from(document.querySelectorAll('video'));
    const imgs = Array.from(document.querySelectorAll('img'));
    const ok = vids.every((v) => !v.seeking && v.readyState >= 2) && imgs.every((i) => i.complete);
    if (ok || performance.now() - t0 > timeoutMs) break;
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
