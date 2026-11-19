import { inspector } from '@vercel/board/inspect';

// Render the package's shell through its public API to reuse the exact installed
// stylesheet. Styling does not need credentials or a request to the Board API.
const nativeShell = inspector({ board: { me: async () => ({ profile: null }) }, basePath: '' });
let stylesheet;

export function nativeStyle() {
  return stylesheet ??= nativeShell(new Request('https://board-style.invalid/'))
    .then((response) => response.text())
    .then((html) => {
      const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1];
      if (!style) throw new Error('The installed Board package did not provide its stylesheet.');
      return style;
    });
}
