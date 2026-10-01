import { describe, expect, it } from 'vitest';
import { svgIntrinsicSize } from './svgSize';

const svg = (attrs: string) => `<?xml version="1.0"?>\n<!-- c --><svg xmlns="http://www.w3.org/2000/svg" ${attrs}><rect width="1" height="1"/></svg>`;

describe('svgIntrinsicSize', () => {
  it('uses the viewBox when there is no width or height', () => {
    expect(svgIntrinsicSize(svg('viewBox="0 0 512 512"'))).toEqual({ w: 512, h: 512 });
    expect(svgIntrinsicSize(svg("viewBox='0,0,24.5,12'"))).toEqual({ w: 24.5, h: 12 });
  });
  it('uses width and height, with units', () => {
    expect(svgIntrinsicSize(svg('width="16" height="8" viewBox="0 0 512 512"'))).toEqual({ w: 16, h: 8 });
    expect(svgIntrinsicSize(svg('width="1in" height="12pt"'))).toEqual({ w: 96, h: 16 });
    expect(svgIntrinsicSize(svg('width="20px" height="10px"'))).toEqual({ w: 20, h: 10 });
  });
  it('scales a lone width or height by the viewBox ratio', () => {
    expect(svgIntrinsicSize(svg('width="100" viewBox="0 0 50 25"'))).toEqual({ w: 100, h: 50 });
    expect(svgIntrinsicSize(svg('height="10" viewBox="0 0 50 25"'))).toEqual({ w: 20, h: 10 });
  });
  it('treats percentages as absent: the viewBox, or null', () => {
    expect(svgIntrinsicSize(svg('width="100%" height="100%" viewBox="0 0 64 32"'))).toEqual({ w: 64, h: 32 });
    expect(svgIntrinsicSize(svg('width="100%" height="100%"'))).toBeNull();
  });
  it('is null with neither, or with no svg root', () => {
    expect(svgIntrinsicSize(svg(''))).toBeNull();
    expect(svgIntrinsicSize(svg('viewBox="0 0 0 0"'))).toBeNull();
    expect(svgIntrinsicSize('not svg')).toBeNull();
  });
});
