import { describe, expect, it, vi } from "vitest";
import { WindowPresentation, type PresentationWindow } from "./window-presentation.js";

describe("Desktop presentation without another conversation writer", () => {
  it("restores clamped bounds after a display changes and leaves pin independent", () => {
    let bounds = { x: 1600, y: 100, width: 1440, height: 900 };
    let area = { x: 1440, y: 0, width: 1920, height: 1080 };
    const window: PresentationWindow = { getBounds: () => ({ ...bounds }), setBounds: next => { bounds = next; }, setMinimumSize: vi.fn(), setAlwaysOnTop: vi.fn(), isDestroyed: () => false };
    const presentation = new WindowPresentation(() => area); presentation.attach(window);
    expect(window.setAlwaysOnTop).toHaveBeenLastCalledWith(false);
    presentation.setFloating(true); expect(bounds).toEqual({ x: 1600, y: 100, width: 880, height: 700 });
    presentation.setAlwaysOnTop(true); area = { x: 0, y: 0, width: 1280, height: 800 };
    presentation.setFloating(false); expect(bounds).toEqual({ x: 0, y: 0, width: 1280, height: 800 });
    expect(presentation.state()).toEqual({ floating: false, alwaysOnTop: true });
    expect(window.setMinimumSize).toHaveBeenLastCalledWith(980, 640);
    presentation.detach(window); expect(() => presentation.setFloating(true)).toThrow("unavailable");
  });
  it("keeps the current application preference after recreating a window", () => {
    const make = (): PresentationWindow => ({ getBounds: () => ({ x: 10, y: 20, width: 1440, height: 920 }), setBounds: vi.fn(), setMinimumSize: vi.fn(), setAlwaysOnTop: vi.fn(), isDestroyed: () => false });
    const first = make(), presentation = new WindowPresentation(() => ({ x: 0, y: 0, width: 1440, height: 900 }));
    presentation.attach(first); presentation.setFloating(true); presentation.setAlwaysOnTop(true); presentation.detach(first);
    const second = make(); presentation.attach(second);
    expect(second.setAlwaysOnTop).toHaveBeenCalledWith(true);
    expect(second.setBounds).toHaveBeenCalledWith({ x: 10, y: 20, width: 880, height: 700 });
    expect(presentation.state()).toEqual({ floating: true, alwaysOnTop: true });
  });
  it("ignores late closure of a previous window and refuses effects on the destroyed current window",()=>{
    let destroyed=false;const make=():PresentationWindow=>({getBounds:()=>({x:0,y:0,width:1440,height:920}),setBounds:vi.fn(),setMinimumSize:vi.fn(),setAlwaysOnTop:vi.fn(),isDestroyed:()=>destroyed});
    const first=make(),second=make(),presentation=new WindowPresentation(()=>({x:0,y:0,width:1920,height:1080}));presentation.attach(first);presentation.attach(second);presentation.detach(first);presentation.setFloating(true);presentation.setAlwaysOnTop(true);
    expect(first.setBounds).not.toHaveBeenCalled();expect(second.setBounds).toHaveBeenCalledOnce();expect(second.setAlwaysOnTop).toHaveBeenLastCalledWith(true);destroyed=true;expect(()=>presentation.setFloating(false)).toThrow("unavailable");expect(()=>presentation.setAlwaysOnTop(false)).toThrow("unavailable");expect(presentation.state()).toEqual({floating:true,alwaysOnTop:true});
  });
});
