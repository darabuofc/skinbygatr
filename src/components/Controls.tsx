'use client';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import * as E from '@/lib/engine';
import { useStore } from '@/lib/hooks';
import {
  addMask, addOutput, addPanel, clearCue, removeMask, setImageMask, setMaskSmooth, setTracedMask, setMeshSize, setPanelInput, updateMask, deletePanel, layerTarget, movePanelLayer, movePanelToOutput, recallCue, removeOutput, redoMapping, runtime, saveCue, selectPanel, setScene, settings, undoMapping,
  updateOutput, updatePanel,
} from '@/lib/store';
import { summarize, type Check } from '@/lib/preflight';
import { BAR_CHOICES, BEATS_PER_BAR, CUE_FADE_CHOICES, FADE_CHOICES } from '@/lib/transitions';
import { SPLIT_DRIVES, type SplitDrive } from '@/lib/effects';
import { FX, fxById, fxIdOf } from '@/lib/fx';
import { allActions, params, resetParams, setParam, type ParamGroup } from '@/lib/params';
import { POST_GROUPS } from '@/lib/post';
import { defaultLabel, MAX_LABEL_CHARS } from '@/lib/text';
import {
  BANDS, BLEND_MODES, MAX_OUTPUTS, SCENES, SCENE_KEYS, TRANSITIONS, type Band, type BlendMode, type Mask, type OutputConfig,
  type PanelLabel, type TransitionMode,
} from '@/lib/types';
import { MAX_MASK_FEATHER } from '@/lib/mask';
import { bakeMaskImage, traceImage, type TraceFit } from '@/lib/trace';
import { MESH_SIZES } from '@/lib/mesh';
import RemotePanel from './RemotePanel';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return <label className="row"><span>{label}</span>{children}</label>;
}

function Slider({ value, min, max, step, onChange, format }: {
  value: number; min: number; max: number; step: number; onChange: (v: number) => void; format: (v: number) => string;
}) {
  return (
    <>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(+e.target.value)} />
      <span className="val">{format(value)}</span>
    </>
  );
}

function Note({ children, warn }: { children?: ReactNode; warn?: boolean }) {
  if (!children) return null;
  return <p className={warn ? 'note warn' : 'note'} role="status">{children}</p>;
}

const SECTIONS_KEY = 'panelmapper.ui.sections';

function readSections(): Record<string, boolean> {
  try { return JSON.parse(localStorage.getItem(SECTIONS_KEY) ?? '{}') ?? {}; } catch { return {}; }
}

/** A collapsible sidebar section whose open/closed state is remembered per id in this browser. */
function Section({ id, title, badge, closed, children }: { id: string; title: string; badge?: ReactNode; closed?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(!closed);
  useEffect(() => {
    const saved = readSections()[id];
    if (typeof saved === 'boolean') setOpen(saved);
  }, [id]);
  const toggle = (o: boolean) => {
    setOpen(o);
    try { localStorage.setItem(SECTIONS_KEY, JSON.stringify({ ...readSections(), [id]: o })); } catch { /* no storage */ }
  };
  return (
    <section>
      <details open={open} onToggle={(e) => { const o = e.currentTarget.open; if (o !== open) toggle(o); }}>
        <summary><h2>{title}{badge}</h2></summary>
        {children}
      </details>
    </section>
  );
}

/** Explanatory text kept out of the way: one line until asked for. Live status stays in Note. */
function Help({ children, label = 'How this works' }: { children?: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (!children) return null;
  return (
    <div className="help">
      <button type="button" className="help-btn" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        <span aria-hidden="true">?</span>{label}
      </button>
      {open && <p className="note" id={id}>{children}</p>}
    </div>
  );
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

type Tab = 'perform' | 'setup';
const TAB_KEY = 'panelmapper.ui.tab';

/** Remembers the last tab across reloads; storage can be blocked, so it never throws. */
function useTab(): [Tab, (t: Tab) => void] {
  const [tab, setTab] = useState<Tab>('setup');
  useEffect(() => {
    try { if (localStorage.getItem(TAB_KEY) === 'perform') setTab('perform'); } catch { /* no storage */ }
  }, []);
  const choose = (t: Tab) => {
    setTab(t);
    try { localStorage.setItem(TAB_KEY, t); } catch { /* no storage */ }
  };
  return [tab, choose];
}

/** Small kick light for the always-visible bar; the full meters live in the Perform tab. */
function KickDot() {
  const el = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let id = 0;
    const tick = () => {
      el.current?.classList.toggle('hit', E.getLevels().kickEnv > 0.3);
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, []);
  return <span className="kick" ref={el} role="img" aria-label="Kick" title="Kick" />;
}

/** Wraps an angle into -180..180. */
const wrapDeg = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

function PanelText({ index, label }: { index: number; label?: PanelLabel }) {
  const l = label ?? defaultLabel();
  const set = (patch: Partial<PanelLabel>) => updatePanel(index, { label: { ...l, ...patch } });
  return (
    <>
      <label className="row text-row">
        <span>Text</span>
        <textarea
          rows={2} maxLength={MAX_LABEL_CHARS} placeholder="No text" value={l.text}
          onChange={(e) => set({ text: e.target.value })}
        />
      </label>
      {l.text.trim() && (
        <>
          <Row label="Rotation">
            <Slider value={l.rotation} min={-180} max={180} step={5} onChange={(v) => set({ rotation: v })} format={(v) => `${v}°`} />
          </Row>
          <div className="btns">
            <button onClick={() => set({ rotation: wrapDeg(l.rotation - 90) })} aria-label="Rotate text 90° anticlockwise">↺ 90°</button>
            <button onClick={() => set({ rotation: 0 })} disabled={l.rotation === 0}>Level</button>
            <button onClick={() => set({ rotation: wrapDeg(l.rotation + 90) })} aria-label="Rotate text 90° clockwise">↻ 90°</button>
          </div>
          <Row label="Text size">
            <Slider value={l.size} min={0.05} max={1} step={0.05} onChange={(v) => set({ size: v })} format={pct} />
          </Row>
          <Row label="Text colour">
            <input type="color" value={l.color} onChange={(e) => set({ color: e.target.value })} />
          </Row>
          <Row label="Text pulses with the music">
            <input type="checkbox" checked={l.pulse} onChange={(e) => set({ pulse: e.target.checked })} />
          </Row>
        </>
      )}
    </>
  );
}

function Meters() {
  const bars = useRef<(HTMLElement | null)[]>([]);
  useEffect(() => {
    let id = 0;
    const tick = () => {
      const L = E.getLevels();
      [L.bass, L.mid, L.high].forEach((v, i) => {
        const el = bars.current[i];
        if (el) el.style.transform = `scaleX(${Math.min(1, v).toFixed(3)})`;
      });
      bars.current[3]?.classList.toggle('hit', L.kickEnv > 0.3);
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, []);
  return (
    <div className="meters" aria-hidden="true">
      {['Bass', 'Mids', 'Highs'].map((n, i) => (
        <div className="meter" key={n}>
          <span>{n}</span>
          <div className="bar"><i ref={(el) => { bars.current[i] = el; }} /></div>
        </div>
      ))}
      <div className="meter"><span>Kick</span><div className="kick" ref={(el) => { bars.current[3] = el; }} /></div>
    </div>
  );
}

/**
 * Live settings with sliders: a panel shader's (shared by every panel showing it) or a projector's
 * post effects. All MIDI-learnable, smoothed on the wall and stored in cues.
 */
function ShaderParams({ def, midi, title, note, plain }: {
  def: ParamGroup; midi: Record<string, unknown>; title?: string; note?: string;
  /** Inside a Section already: a titled group rather than a box of its own. */
  plain?: boolean;
}) {
  const values = useStore(params);
  const fmt = (v: number, range: number) => (range >= 10 ? v.toFixed(0) : range >= 2 ? v.toFixed(1) : v.toFixed(2));
  const Box = plain ? 'div' : 'details';
  return (
    <Box className="params" {...(plain ? {} : { open: true })}>
      {plain ? <p className="params-title">{title ?? def.name}</p> : <summary>{title ?? `${def.name} settings`}</summary>}
      {def.params.map((pr) => (
        <Row key={pr.name} label={`${pr.label}${midi[`param:${def.id}:${pr.name}`] ? ' (MIDI)' : ''}`}>
          <Slider value={values[def.id]?.[pr.name] ?? pr.default} min={pr.min} max={pr.max} step={(pr.max - pr.min) / 200}
            onChange={(v) => setParam(def.id, pr.name, v)} format={(v) => fmt(v, pr.max - pr.min)} />
        </Row>
      ))}
      <div className="btns">
        {(def.triggers ?? []).map((t) => (
          <button key={t.id} className="primary" onClick={() => E.triggerFx(def.id, t.id)}>
            {t.label}{midi[`fxtrigger:${def.id}:${t.id}`] ? ' (MIDI)' : ''}
          </button>
        ))}
        <button onClick={() => resetParams(def.id)}>Reset to defaults</button>
      </div>
      {def.params.some((pr) => pr.engine) && (
        <Help>Blinks and wandering run by themselves, on top of the eye settings above, so the eye stays alive with nobody at the controls. Set blinks per minute or wander to 0 to stop them.</Help>
      )}
      {note !== '' && (
        <Help>{note ?? `These apply to every panel showing ${def.name}, change smoothly on the wall, and can be learned to MIDI knobs under MIDI controller.`}</Help>
      )}
    </Box>
  );
}

/** The selected panel's freeform mask: add, edit points, feather, invert, remove. */
function PanelMask({ index, mask, editing }: { index: number; mask?: Mask; editing: boolean }) {
  const setEditing = (on: boolean) => runtime.set((r) => ({ maskEdit: on, selCorner: on || r.selCorner?.m === undefined ? r.selCorner : null }));
  const picker = useRef<HTMLInputElement>(null);
  const [fit, setFit] = useState<TraceFit>('image');
  const [note, setNote] = useState('');
  /** What the picked file becomes: the exact picture as the mask, or a traced outline. */
  const how = useRef<'exact' | 'trace' | 'photo'>('exact');
  const pick = (mode: 'exact' | 'trace' | 'photo') => { how.current = mode; picker.current?.click(); };
  const fromImage = async (file?: File) => {
    if (!file) return;
    const corners = settings.get().panels[index]?.corners;
    if (!corners) return;
    try {
      if (how.current === 'photo') {
        const baked = await bakeMaskImage(file, { source: 'photo', fit: 'shape' });
        if (!baked) { setNote('Could not find the cutout in that photo. It needs to be a warm-coloured board against a paler wall or floor.'); return; }
        setImageMask(index, baked);
        setNote(settings.get().panels[index]?.mask?.image ? 'Cut out the board from the photo. Drag the panel corners onto the board.' : 'That photo is too detailed to store; try a smaller one.');
        return;
      }
      if (how.current === 'exact') {
        const baked = await bakeMaskImage(file, { fit });
        if (!baked) { setNote('No shape found in that picture. Use a cutout with a transparent background, or a white shape on black.'); return; }
        setImageMask(index, baked);
        const stored = settings.get().panels[index]?.mask?.image;
        setNote(stored ? 'Picture set as the mask.' : 'That picture is too detailed to store; try a smaller or simpler one.');
        return;
      }
      const traced = await traceImage(file, corners, { fit });
      if (!traced) { setNote('No shape found in that picture. Use a cutout with a transparent background, or a white shape on black.'); return; }
      setTracedMask(index, traced);
      setNote(`Traced ${traced.points.length} points.`);
    } catch {
      setNote('That file could not be read as a picture.');
    }
  };
  const fromImageUi = (
    <>
      <Row label="Mask from picture">
        <span className="btns">
          <button onClick={() => pick('photo')}>Cut out from photo…</button>
          <button onClick={() => pick('exact')}>Use picture as mask…</button>
          <button onClick={() => pick('trace')}>Trace outline…</button>
          <select value={fit} aria-label="Place the picture" onChange={(e) => setFit(e.target.value as TraceFit)}>
            <option value="image">Picture fills panel</option>
            <option value="shape">Shape fills panel</option>
          </select>
        </span>
        <input ref={picker} type="file" accept="image/png,image/webp,image/jpeg" hidden
          onChange={(e) => { void fromImage(e.target.files?.[0]); e.target.value = ''; }} />
      </Row>
      {note && <Note>{note}</Note>}
    </>
  );
  if (!mask) {
    return (
      <>
        <Row label="Mask">
          <button onClick={() => addMask(index)}>Add mask</button>
        </Row>
        {fromImageUi}
      </>
    );
  }
  return (
    <>
      <Row label={mask.image ? 'Picture mask' : 'Mask'}>
        <span className="btns">
          {!mask.image && <button className={editing ? 'on' : ''} aria-pressed={editing} onClick={() => setEditing(!editing)}>{editing ? 'Done editing' : 'Edit points'}</button>}
          <button onClick={() => removeMask(index)}>Remove</button>
        </span>
      </Row>
      {fromImageUi}
      {mask.image && <Help label="About picture masks">The picture is the mask: white shows the panel, transparent hides it, holes and separate pieces included. It lies on the panel's own surface, so it follows the corners and any mesh, and Shape fills panel crops it to its shape first. Cut out from photo finds the real board in a photo of it and uses its exact outline, cropped to the board so the panel's corners belong on the board's corners. It has no points to edit; trace it to get an outline you can adjust. Feather softens its edge.</Help>}
      <Row label="Mask feather">
        <Slider value={mask.feather} min={0} max={MAX_MASK_FEATHER} step={0.002} onChange={(v) => updateMask(index, { feather: v })}
          format={(v) => (v === 0 ? 'Hard' : `${Math.round(v * 1080)} px`)} />
      </Row>
      <Row label={mask.image ? 'Show outside the picture' : 'Show outside the outline'}>
        <input type="checkbox" checked={mask.invert} onChange={(e) => updateMask(index, { invert: e.target.checked })} />
      </Row>
      {editing && !mask.image && (
        <>
          <div className="btns spaced">
            <button onClick={() => setMaskSmooth(index, true)}>All smooth</button>
            <button onClick={() => setMaskSmooth(index, false)}>All corners</button>
          </div>
          <Help>Drag the blue points onto the edge of the surface; arrow keys nudge the last one touched. A traced picture is only a starting outline, so tidy it here too. Click the dashed outline to add a point, double-click a point to switch between curve and corner, and Option/Alt-click to delete it. The mask is part of the mapping: undo covers it and cues leave it alone. Feather fades the edge inwards, so no light spills past the line (px at 1080p). The test grid ignores masks.</Help>
        </>
      )}
    </>
  );
}

/** One projector: its window, its name and how its picture is flipped. */
function ProjectorCard({ o, index, multi, open }: { o: OutputConfig; index: number; multi: boolean; open: boolean }) {
  const first = index === 0;
  const openLabel = open ? (multi ? 'Focus window' : 'Focus projector window') : (multi ? 'Open window' : 'Open projector window');
  return (
    <div className={multi ? 'proj' : undefined}>
      {multi && (
        <Row label="Name">
          <input type="text" value={o.name} maxLength={40} onChange={(e) => updateOutput(o.id, { name: e.target.value })}
            onBlur={(e) => { if (!e.target.value.trim()) updateOutput(o.id, { name: first ? 'Projector 1' : 'Projector 2' }); }} />
        </Row>
      )}
      <div className="btns">
        <button className="primary" onClick={() => E.openOutput(o.id)}>{openLabel}</button>
        {multi && open && <button onClick={() => E.closeOutput(o.id)}>Close window</button>}
        {multi && !first && (
          <button onClick={() => { if (confirm(`Remove ${o.name}? Its panels move to the first projector.`)) removeOutput(o.id); }}>Remove</button>
        )}
      </div>
      <Row label="Flip left–right (rear projection)">
        <input type="checkbox" checked={o.flipH} onChange={(e) => updateOutput(o.id, { flipH: e.target.checked })} />
      </Row>
      <Row label="Flip upside down (ceiling mount)">
        <input type="checkbox" checked={o.flipV} onChange={(e) => updateOutput(o.id, { flipV: e.target.checked })} />
      </Row>
      {(o.flipH || o.flipV) && (
        <Help>Only the projector’s picture is mirrored. With its window open, the live copy here and its corner dots show the surface as the audience sees it. If the projector has its own Rear or Ceiling mode, use that instead and leave these off, so the picture isn’t flipped twice.</Help>
      )}
    </div>
  );
}

const STATUS_TEXT = { ok: 'OK', warn: 'Check', fail: 'Fix', skip: 'n/a' } as const;

function Preflight({ active }: { active: boolean }) {
  const [checks, setChecks] = useState<Check[]>([]);
  useEffect(() => {
    if (!active) return;
    let live = true;
    const run = () => E.preflight().then((c) => { if (live) setChecks(c); });
    run();
    const id = setInterval(run, 1000);
    return () => { live = false; clearInterval(id); };
  }, [active]);
  const sum = summarize(checks);
  const label = !checks.length ? '' : sum.clear ? 'All clear' : [
    sum.fail && `${sum.fail} to fix`, sum.warn && `${sum.warn} to check`,
  ].filter(Boolean).join(', ');
  return (
    <Section id="preflight" title={'Pre-show check'} closed badge={label && <small className={`pf-sum ${sum.fail ? 'fail' : sum.warn ? 'warn' : 'ok'}`}>{label}</small>}>
        <ul className="pf" aria-live="polite">
          {checks.map((c) => (
            <li key={c.id} className={c.status}>
              <span className="pf-badge">{STATUS_TEXT[c.status]}</span>
              <div>
                <span>{c.label}</span>
                {c.hint && <small>{c.hint}</small>}
              </div>
            </li>
          ))}
        </ul>
        <Help>Run through this after setting up at the venue. It updates live, so you can fix things and watch them turn OK.</Help>
    </Section>
  );
}

export default function Controls({ hidden }: { hidden: boolean }) {
  const s = useStore(settings);
  const r = useStore(runtime);
  const videoInput = useRef<HTMLInputElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const trackInput = useRef<HTMLInputElement>(null);
  const layoutInput = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useTab();
  const p = s.panels[s.selected];
  const outName = (id: string) => s.outputs.find((o) => o.id === id)?.name ?? '';

  const sourceName = (src: string) => {
    if (src === 'gen') return 'Generated';
    const fx = fxIdOf(src);
    if (fx !== null) return fxById(fx)?.name ?? 'Missing shader';
    const v = r.videos.find((x) => `vid:${x.id}` === src);
    if (src.startsWith('img:')) return r.images.find((x) => `img:${x.id}` === src)?.name ?? 'Missing picture';
    return v ? v.name : 'Missing video';
  };

  return (
    <aside
      id="ui"
      hidden={hidden}
      aria-label="Controls"
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }}
      onDrop={(e) => { e.preventDefault(); if (e.dataTransfer.files.length) E.addVideoFiles(e.dataTransfer.files); }}
    >
      <header className="head">
        <h1>Panel Mapper</h1>
        <p className="sub">Fit visuals onto your panels and let the music drive them.</p>
        {(r.offlineReady || r.wakeLock) && (
          <p className="status-line">
            {r.offlineReady && <span className="dot">Works offline</span>}
            {r.wakeLock && <span className="dot">Screen stays awake</span>}
          </p>
        )}
      </header>

      <div className="dock">
        <div className="transport">
          <button className={r.blackout ? 'on' : ''} aria-pressed={r.blackout} onClick={E.toggleBlackout} aria-keyshortcuts="B">Blackout <kbd>B</kbd></button>
          <button className={r.showMode ? 'on' : ''} aria-pressed={r.showMode} onClick={E.toggleShow} aria-keyshortcuts="E">Show <kbd>E</kbd></button>
          <KickDot />
          <label className="master">
            <span>Master</span>
            <input type="range" min={0} max={1} step={0.01} value={s.master} aria-label="Master brightness"
              onChange={(e) => settings.set({ master: +e.target.value })} />
            <span className="val">{pct(s.master)}</span>
          </label>
        </div>
        <div className="tabs" role="tablist" aria-label="Controls">
          {([['perform', 'Perform'], ['setup', 'Setup']] as const).map(([id, name]) => (
            <button key={id} role="tab" id={`tab-${id}`} aria-selected={tab === id} aria-controls="tabpanel" className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
              {name}
            </button>
          ))}
        </div>
      </div>

      <div id="tabpanel" role="tabpanel" aria-labelledby={`tab-${tab}`} className={tab}>
      {tab === 'setup' && <>
      <Preflight active={!hidden} />

      <Section id="projector" title={s.outputs.length > 1 ? 'Projectors' : 'Projector'}>
        {s.outputs.map((o, i) => (
          <ProjectorCard key={o.id} o={o} index={i} multi={s.outputs.length > 1} open={r.openOutputs.includes(o.id)} />
        ))}
        {s.outputs.length < MAX_OUTPUTS && (
          <div className="btns spaced">
            <button onClick={() => addOutput()}>Add a second projector</button>
          </div>
        )}
        <Help>
          {s.outputs.length > 1
            ? 'Open each projector’s window, drag it onto its projector, click inside it and press F. Both run from one clock, so they move together. Pick a panel to edit it in the live copy here.'
            : 'Drag the new window onto the projector screen, click inside it and press F. Then drag the corner dots in the live copy here to fit each panel; tick “Dots on the wall” to see them on the surface too.'}
        </Help>
        <Note warn>{r.outMsg}</Note>
        <Row label="Test grid (G)">
          <input type="checkbox" checked={s.testGrid} onChange={(e) => settings.set({ testGrid: e.target.checked })} />
        </Row>
      </Section>

      <Section id="panels" title={'Panels'}>
        <ul className="list">
          {s.panels.map((pn, i) => (
            <li key={pn.id} className={i === s.selected ? 'sel' : ''}>
              <button className="li-btn" onClick={() => selectPanel(i)} aria-current={i === s.selected}>
                <span>Panel {i + 1}</span><small>{s.outputs.length > 1 ? `${outName(pn.output)} · ` : ''}{sourceName(pn.source)}</small>
              </button>
            </li>
          ))}
        </ul>
        <div className="btns">
          <button onClick={addPanel} disabled={s.panels.length >= 12}>Add panel</button>
          <button onClick={() => deletePanel(s.selected)} disabled={s.panels.length <= 1}>Delete selected</button>
        </div>
        <div className="btns spaced">
          <button onClick={undoMapping} disabled={!r.canUndo} aria-keyshortcuts="Meta+Z Control+Z">Undo</button>
          <button onClick={redoMapping} disabled={!r.canRedo} aria-keyshortcuts="Meta+Shift+Z Control+Y">Redo</button>
        </div>
        <Row label="Zoom while moving a corner">
          <input type="checkbox" checked={s.loupe} onChange={(e) => settings.set({ loupe: e.target.checked })} />
        </Row>
        <Help>Undo covers corner moves, nudges, masks, layer order and adding or removing panels. Hold Shift while dragging for fine control.</Help>
        {p && (
          <>
            {s.outputs.length > 1 && (
              <Row label="On projector">
                <select value={p.output} onChange={(e) => movePanelToOutput(s.selected, e.target.value)}>
                  {s.outputs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              </Row>
            )}
            <Row label={`Panel ${s.selected + 1} shows`}>
              <select value={p.source} onChange={(e) => updatePanel(s.selected, { source: e.target.value })}>
                <option value="gen">Generated visuals</option>
                <optgroup label="Panel shaders">
                  {FX.map((f) => <option key={f.id} value={`fx:${f.id}`}>{f.name}</option>)}
                </optgroup>
                {r.videos.length > 0 && (
                  <optgroup label="Videos">
                    {r.videos.map((v) => <option key={v.id} value={`vid:${v.id}`}>{v.name}</option>)}
                  </optgroup>
                )}
                {r.images.length > 0 && (
                  <optgroup label="Pictures">
                    {r.images.map((im) => <option key={im.id} value={`img:${im.id}`}>{im.name}</option>)}
                  </optgroup>
                )}
                {p.source.startsWith('img:') && !r.images.some((im) => `img:${im.id}` === p.source) && (
                  <option value={p.source}>Missing picture</option>
                )}
                {p.source.startsWith('vid:') && !r.videos.some((v) => `vid:${v.id}` === p.source) && (
                  <option value={p.source}>Missing video</option>
                )}
              </select>
            </Row>
            {(fxById(fxIdOf(p.source) ?? '')?.textures ?? []).map((tx) => {
              const cur = p.inputs?.[tx.name] ?? '';
              return (
                <Row key={tx.name} label={tx.label}>
                  <select value={cur} onChange={(e) => setPanelInput(s.selected, tx.name, e.target.value)}>
                    <option value="">None (flat)</option>
                    {r.images.map((im) => <option key={im.id} value={im.id}>{im.name}</option>)}
                    {cur && !r.images.some((im) => im.id === cur) && <option value={cur}>Missing image</option>}
                  </select>
                </Row>
              );
            })}
            {fxById(fxIdOf(p.source) ?? '') && <ShaderParams def={fxById(fxIdOf(p.source)!)!} midi={s.midi} />}
            {fxIdOf(p.source) !== null && (
              <Help>{fxById(fxIdOf(p.source)!)?.description} It reacts to the music itself, so set Pulses with to Nothing (steady) unless you want the whole panel to pump as well.</Help>
            )}
            <Row label="Pulses with">
              <select value={p.band} onChange={(e) => updatePanel(s.selected, { band: e.target.value as Band })}>
                {BANDS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
              </select>
            </Row>
            <Row label="Warp">
              <select value={p.mesh ? String(p.mesh.cols) : '0'} onChange={(e) => setMeshSize(s.selected, Number(e.target.value))}>
                <option value="0">4 corners (flat)</option>
                {MESH_SIZES.map((n) => <option key={n} value={n}>{`Mesh ${n} × ${n} (curved)`}</option>)}
              </select>
            </Row>
            {p.mesh && (
              <Help>Drag the pink grid points onto the surface; the picture bends smoothly through them, so a 4 × 4 or 5 × 5 grid can follow a bowl. Arrow keys nudge the last one touched; drag the number to move the whole panel. Changing the grid size keeps the current shape, and 4 corners goes back to a flat warp (undo brings the mesh back).</Help>
            )}
            <Row label="Edge softness">
              <Slider value={p.feather} min={0} max={0.2} step={0.01} onChange={(v) => updatePanel(s.selected, { feather: v })} format={(v) => (v === 0 ? 'Off' : pct(v / 0.2))} />
            </Row>
            <Row label="Blend">
              <select value={p.blend} onChange={(e) => updatePanel(s.selected, { blend: e.target.value as BlendMode })}>
                {BLEND_MODES.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
              </select>
            </Row>
            <Row label="Opacity">
              <Slider value={p.opacity} min={0} max={1} step={0.01} onChange={(v) => updatePanel(s.selected, { opacity: v })} format={pct} />
            </Row>
            <Row label="Layer">
              <span className="btns">
                <button onClick={() => movePanelLayer(s.selected, -1)} disabled={layerTarget(s.panels, s.selected, -1) === null}>Send back</button>
                <button onClick={() => movePanelLayer(s.selected, 1)} disabled={layerTarget(s.panels, s.selected, 1) === null}>Bring forward</button>
              </span>
            </Row>
            <Help>Panels lower in the list draw on top of earlier ones on the same projector. Add and Screen brighten what’s beneath (light on light), Multiply darkens it (shadows and tints). The test grid shows every panel as Normal.</Help>
            <PanelMask index={s.selected} mask={p.mask} editing={r.maskEdit} />
            <PanelText index={s.selected} label={p.label} />
          </>
        )}
        <Row label="Spread one image across all panels">
          <input type="checkbox" checked={s.span} onChange={(e) => settings.set({ span: e.target.checked })} />
        </Row>
      </Section>
      </>}

      {tab === 'perform' && <>
      <Section id="cues" title={'Cues'}>
        <p className="note">
          {r.cueSaveMode
            ? 'Choose a slot to save the current look into.'
            : 'Saved looks you can switch to instantly. Shift + 1–8 recalls them from the keyboard; right-click a slot to clear it.'}
        </p>
        <div className="cues">
          {s.cues.map((c, i) => (
            <button
              key={i}
              className={`cue${c ? ' filled' : ''}${r.cueSaveMode ? ' saving' : ''}`}
              onClick={() => {
                if (r.cueSaveMode) { saveCue(i); runtime.set({ cueSaveMode: false }); } else if (c) recallCue(i);
              }}
              onContextMenu={(e) => { e.preventDefault(); if (c) clearCue(i); }}
              aria-label={c ? `Cue ${i + 1}, ${SCENES[c.scene]}${c.fadeSec !== undefined ? `, ${c.fadeSec} second fade` : ''}` : `Cue ${i + 1}, empty`}
              title={c ? (c.fadeSec !== undefined ? (c.fadeSec ? `Fades in over ${c.fadeSec} s` : 'Cuts straight in') : 'Fades over the scene fade (saved before cue fade times)') : undefined}
            >
              <span>{i + 1}</span>
              <small>{c ? (c.fadeSec !== undefined ? `${c.fadeSec ? `${c.fadeSec}s fade` : 'Cut'}` : SCENES[c.scene]) : 'Empty'}</small>
            </button>
          ))}
        </div>
        <div className="btns spaced">
          <button className={r.cueSaveMode ? 'on' : ''} onClick={() => runtime.set((x) => ({ cueSaveMode: !x.cueSaveMode }))}>
            {r.cueSaveMode ? 'Cancel saving' : 'Save current look'}
          </button>
        </div>
        <Row label="Fade for new cues">
          <select value={s.cueFade} onChange={(e) => settings.set({ cueFade: +e.target.value })}>
            {CUE_FADE_CHOICES.map((n) => <option key={n} value={n}>{n === 0 ? 'Cut (no fade)' : `${n} s`}</option>)}
          </select>
        </Row>
        <Help>A cue keeps the scene, colours, every panel’s content, blend and opacity, all shader settings, post effects and the transition, but never the mapping (corners, meshes, masks). Recalling it fades everything over the time it was saved with, content changing with its transition; save again to change either. Moving a slider during a fade takes over straight away.</Help>
      </Section>

      <Section id="beat" title={'Beat'}>
        <div className="btns">
          <button className={r.audioOn ? '' : 'primary'} onClick={() => (r.audioOn ? E.stopAudio() : E.startAudio())}>
            {r.trackName ? 'Stop test track' : r.audioOn ? 'Stop audio input' : 'Start audio input'}
          </button>
          {r.trackName && (
            <button className={r.trackPlaying ? 'on' : ''} aria-pressed={r.trackPlaying} onClick={E.toggleTrack}>
              {r.trackPlaying ? 'Pause' : 'Play'}
            </button>
          )}
        </div>
        <Meters />
        <Row label="Auto beat without audio">
          <input type="checkbox" checked={s.autoBpm} onChange={(e) => settings.set({ autoBpm: e.target.checked })} />
        </Row>
        <div className="row">
          <span>Beat speed (BPM)</span>
          <span className="inline">
            <input
              type="number" min={60} max={200} value={s.bpm} aria-label="Beats per minute"
              onChange={(e) => settings.set({ bpm: +e.target.value || 0 })}
              onBlur={() => settings.set((x) => ({ bpm: Math.min(200, Math.max(60, x.bpm || 126)) }))}
            />
            <button onClick={E.tap}>Tap (T)</button>
          </span>
        </div>
        <Note>{r.audioMsg || 'Audio is off. Visuals run on a gentle idle beat until you start the input.'}</Note>
      </Section>

      <Section id="visuals" title={'Visuals'}>
        <div className="btns scenes">
          {SCENES.map((n, i) => (
            <button key={n} className={i === s.scene ? 'on' : ''} aria-pressed={i === s.scene} onClick={() => setScene(i)}>
              {SCENE_KEYS[i]} {n}
            </button>
          ))}
        </div>
        <Row label="Change scene automatically">
          <input type="checkbox" checked={s.autoCycle} onChange={(e) => settings.set({ autoCycle: e.target.checked })} />
        </Row>
        <Row label="Every">
          <select value={s.cycleBars} onChange={(e) => settings.set({ cycleBars: +e.target.value })}>
            {BAR_CHOICES.map((b) => <option key={b} value={b}>{b} {b === 1 ? 'bar' : 'bars'} ({b * BEATS_PER_BAR} beats)</option>)}
          </select>
        </Row>
        <Row label="Crossfade">
          <select value={s.fadeBeats} onChange={(e) => settings.set({ fadeBeats: +e.target.value })}>
            {FADE_CHOICES.map((b) => <option key={b} value={b}>{b === 0 ? 'Off (hard cut)' : `${b} ${b === 1 ? 'beat' : 'beats'}`}</option>)}
          </select>
        </Row>
        <Row label="Transition">
          <select value={s.transition} onChange={(e) => settings.set({ transition: e.target.value as TransitionMode })}>
            {TRANSITIONS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
          </select>
        </Row>
        <Help>Automatic changes land on a kick. Counting restarts whenever you change scene yourself, so change once on a drop and the rest follow the phrase. Crossfades apply to scene changes and cue recalls; Transition sets how they look, and cues keep the one they were saved with.</Help>
        <Row label="Main color"><input type="color" value={s.c1} onChange={(e) => settings.set({ c1: e.target.value })} /></Row>
        <Row label="Second color"><input type="color" value={s.c2} onChange={(e) => settings.set({ c2: e.target.value })} /></Row>
        <Row label="Reactivity">
          <Slider value={s.react} min={0} max={1} step={0.05} onChange={(v) => settings.set({ react: v })} format={pct} />
        </Row>
        <Row label="Flash on kick">
          <input type="checkbox" checked={s.strobe} onChange={(e) => settings.set({ strobe: e.target.checked })} />
        </Row>
        <Row label="RGB split">
          <Slider value={s.rgbSplit} min={0} max={1} step={0.05} onChange={(v) => settings.set({ rgbSplit: v })} format={(v) => (v ? pct(v) : 'Off')} />
        </Row>
        <Row label="Split follows">
          <select value={s.rgbDrive} onChange={(e) => settings.set({ rgbDrive: e.target.value as SplitDrive })}>
            {SPLIT_DRIVES.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
          </select>
        </Row>
        <Note>Hold Space for a manual flash. Flashing can affect people with photosensitivity, so keep it to short moments.</Note>
      </Section>

      <Section id="post" title={'Post effects'} closed>
        {s.outputs.map((o, i) => POST_GROUPS[i] && (
          <ShaderParams key={o.id} def={POST_GROUPS[i]} midi={s.midi} plain title={s.outputs.length > 1 ? o.name : 'Projector'} note="" />
        ))}
        <Help>A finishing pass over each projector’s whole picture: bloom (light spilling around bright areas), water shimmer, tint, saturation and vignette. At their defaults nothing is added and the pass costs nothing. Every setting can be learned to a MIDI knob, eases smoothly on the wall, and is kept in cues.</Help>
      </Section>

      </>}

      {tab === 'setup' && <>
      <Section id="sound" title={'Sound input'}>
        <Row label="Input">
          <select
            value={s.audioDevice}
            onChange={(e) => { settings.set({ audioDevice: e.target.value }); if (r.audioOn) E.startAudio(e.target.value); }}
          >
            <option value="">Default input</option>
            {r.devices.filter((d) => d.id && d.id !== 'default').map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
          </select>
        </Row>
        <Row label="Input gain">
          <Slider value={s.gain} min={0.2} max={6} step={0.1} onChange={(v) => settings.set({ gain: v })} format={(v) => v.toFixed(1)} />
        </Row>
        <Row label="Kick sensitivity">
          <Slider value={s.sens} min={1.1} max={2.5} step={0.05} onChange={(v) => settings.set({ sens: v })} format={(v) => v.toFixed(2)} />
        </Row>
        <div className="btns spaced">
          <button onClick={() => trackInput.current?.click()}>{r.trackName ? 'Change track' : 'Play a test track'}</button>
        </div>
        <input
          ref={trackInput} type="file" accept="audio/*,.mp3,.wav,.m4a,.aac,.flac,.ogg" hidden
          onChange={(e) => { const f = e.target.files?.[0]; if (f) E.playTrack(f); e.target.value = ''; }}
        />
        <Help>Start or stop the input from the Perform tab, where the level meters are. A test track lets you rehearse reactivity without a live feed.</Help>
      </Section>

      <Section id="remote" title={'Remote'} closed>
        <RemotePanel />
        <Help>Control scenes, cues, blackout, flash and effect sliders from a phone or tablet, and with “Run the show and edit mapping” also move corners, mesh points and mask points from its Map tab (it shares the Mac’s undo). The Mac keeps running the show; the remote only sends commands. Anyone with the link can control it, so keep the QR code to yourself and make a new code if it leaks.</Help>
      </Section>

      <Section id="videos" title={'Videos'}>
        <input
          ref={videoInput} type="file" accept="video/*,.mov,.m4v" multiple hidden
          onChange={(e) => { if (e.target.files) E.addVideoFiles(e.target.files); e.target.value = ''; }}
        />
        <div className="btns"><button onClick={() => videoInput.current?.click()}>Add videos</button></div>
        {r.videos.length > 0 && (
          <ul className="list">
            {r.videos.map((v) => (
              <li key={v.id} className="vid">
                <span className="name">{v.name}</span>
                <small>{E.fmtBytes(v.size)}</small>
                <button className="x" onClick={() => E.removeVideo(v.id)} aria-label={`Remove ${v.name}`}>Remove</button>
              </li>
            ))}
          </ul>
        )}
        <Help>
          {r.videos.length
            ? 'Videos are stored in this browser, so they’re still here after a reload or without internet.'
            : 'No videos yet; generated visuals work without any. Drop files here or add them. MP4 (H.264) plays most reliably.'}
        </Help>
        <Note>{r.storageMsg}</Note>
        <Note warn>{r.libraryMsg}</Note>
      </Section>

      <Section id="images" title={'Images'}>
        <input
          ref={imageInput} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden
          onChange={(e) => { if (e.target.files) E.addImageFiles(e.target.files); e.target.value = ''; }}
        />
        <div className="btns"><button onClick={() => imageInput.current?.click()}>Add images</button></div>
        {r.images.length > 0 && (
          <ul className="list">
            {r.images.map((im) => (
              <li key={im.id} className="vid">
                <span className="name">{im.name}</span>
                <small>{im.w} × {im.h}</small>
                <select
                  aria-label={`Show ${im.name} on a panel`}
                  value=""
                  onChange={(e) => { if (e.target.value !== '') updatePanel(+e.target.value, { source: `img:${im.id}` }); }}
                >
                  <option value="">Show on…</option>
                  {s.panels.map((pn, i) => (
                    <option key={pn.id} value={i}>Panel {i + 1} - image{pn.source === `img:${im.id}` ? ' ✓' : ''}</option>
                  ))}
                </select>
                <button className="x" onClick={() => E.removeImage(im.id)} aria-label={`Remove ${im.name}`}>Remove</button>
              </li>
            ))}
          </ul>
        )}
        <Help>Height maps and other images for panel shaders, stored in this browser. A height map is greyscale, white nearest the projector, and covers exactly the panel it’s used on: line up a photo taken from the projector, crop it to the panel, and paint the depth. 16-bit PNGs load as 8-bit, so blur a little to avoid steps.</Help>
        <Note warn>{r.imageMsg}</Note>
      </Section>

      <Section id="midi" title={'MIDI controller'} closed>
          <div className="btns"><button onClick={E.connectMidi}>{r.midiOn ? 'Refresh MIDI' : 'Connect MIDI'}</button></div>
          <Note>{r.midiMsg}</Note>
          {r.midiOn && (
            <>
              <p className="note">Choose Learn next to an action, then press a pad or move a knob on your controller.</p>
              <ul className="midi">
                {allActions().map((a) => {
                  const b = s.midi[a.id];
                  const learning = r.midiLearn === a.id;
                  return (
                    <li key={a.id}>
                      <span className="name">{a.label}</span>
                      <small>{b ? `${b.kind === 'cc' ? 'Knob' : 'Pad'} ${b.num}, ch ${b.channel + 1}` : 'Not set'}</small>
                      <button className={learning ? 'on' : ''} onClick={() => E.learn(a.id)}>{learning ? 'Listening' : 'Learn'}</button>
                      {b && <button className="x" onClick={() => E.clearBinding(a.id)} aria-label={`Clear ${a.label}`}>Clear</button>}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
      </Section>

      <Section id="layout" title={'Layout'}>
        <input
          ref={layoutInput} type="file" accept=".json,application/json" hidden
          onChange={(e) => { const f = e.target.files?.[0]; if (f) E.importLayout(f); e.target.value = ''; }}
        />
        <div className="btns">
          <button onClick={E.exportLayout}>Export layout</button>
          <button onClick={() => layoutInput.current?.click()}>Import layout</button>
          <button onClick={() => { if (confirm('Reset panels, cues and settings to the starting layout? Videos stay in the library.')) E.resetAll(); }}>Reset</button>
        </div>
        <Help>Panels, cues, MIDI mappings and settings save automatically. Export a copy after mapping each venue.</Help>
      </Section>

      <Section id="keyboard" title={'Keyboard'} closed>
          <div className="keys">
            <kbd>E</kbd><span>Show mode: hides the dots (and these controls in one-window mode)</span>
            <kbd>F</kbd><span>Fullscreen the window you’re in</span>
            <kbd>H</kbd><span>Hide or show these controls</span>
            <kbd>B</kbd><span>Blackout</span>
            <kbd>G</kbd><span>Test grid</span>
            <kbd>Space</kbd><span>Flash while held</span>
            <kbd>T</kbd><span>Tap tempo</span>
            <span><kbd>1</kbd>–<kbd>0</kbd> <kbd>-</kbd> <kbd>=</kbd></span><span>Switch scene</span>
            <span><kbd>Shift</kbd> <kbd>1</kbd>–<kbd>8</kbd></span><span>Recall cue</span>
            <kbd>Arrows</kbd><span>Nudge the last corner you touched; hold Shift for bigger steps</span>
            <span><kbd>Shift</kbd> + drag</span><span>Move a corner at one tenth of the speed</span>
            <span><kbd>⌘</kbd>/<kbd>Ctrl</kbd> <kbd>Z</kbd></span><span>Undo a mapping change</span>
            <span><kbd>⌘</kbd> <kbd>Shift</kbd> <kbd>Z</kbd> / <kbd>Ctrl</kbd> <kbd>Y</kbd></span><span>Redo</span>
          </div>
      </Section>
      </>}
      </div>
    </aside>
  );
}
