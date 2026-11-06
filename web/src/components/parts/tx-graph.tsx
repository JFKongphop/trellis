"use client";

import { useMemo, useState } from "react";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Panel,
  Handle,
  Position,
  MarkerType,
  useReactFlow,
  type Node,
  type Edge,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import dagre from "@dagrejs/dagre";
import { Maximize2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TxStep, TxView } from "@/lib/tx-view";
import { stepIcon, stepTitle } from "@/components/parts/tx-step-meta";

// The actions of a NEAR transaction list as a top→bottom flow (React Flow + dagre).
// Edges show order only: a new transaction starts where the dashed edge begins.

const NODE_W = 196;
const NODE_H = 58;

type NodeData = { step: TxStep; selected: boolean; dimmed: boolean };

const nodeTypes = { step: StepNode };

export function TxGraph({
  view,
  selected,
  onSelect,
}: {
  view: TxView;
  selected: number | null;
  onSelect: (index: number) => void;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const layout = useMemo(() => computeLayout(view.steps), [view.steps]);

  const active = hover ?? selected;
  const neighbors = useMemo(() => {
    if (active === null) return null;
    const s = view.steps[active];
    if (!s) return null;
    return new Set<number>([active, ...(s.after !== null ? [s.after] : []), ...(s.before !== null ? [s.before] : [])]);
  }, [active, view.steps]);

  const nodes: Node<NodeData>[] = useMemo(
    () =>
      view.steps.map((step) => ({
        id: String(step.index),
        type: "step",
        position: layout[step.index],
        data: { step, selected: selected === step.index, dimmed: neighbors !== null && !neighbors.has(step.index) },
        draggable: false,
        selectable: false,
        connectable: false,
      })),
    [view.steps, layout, selected, neighbors],
  );

  const edges: Edge[] = useMemo(() => {
    const out: Edge[] = [];
    for (const s of view.steps) {
      if (s.after === null) continue;
      const p = s.after;
      const newTx = view.steps[p]!.txIndex !== s.txIndex;
      const on = active !== null && (p === active || s.index === active);
      out.push({
        id: `${p}-${s.index}`,
        source: String(p),
        target: String(s.index),
        type: "smoothstep",
        animated: on,
        label: newTx ? `tx ${s.txIndex + 1}` : undefined,
        markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: on ? "#47d096" : "#1111111f" },
        style: {
          stroke: on ? "#47d096" : "#11111126",
          strokeWidth: on ? 2 : 1.25,
          strokeDasharray: newTx ? "5 4" : undefined,
          opacity: active !== null && !on ? 0.35 : 1,
        },
      });
    }
    return out;
  }, [view.steps, active]);

  return (
    <div className="h-full min-h-[180px] w-full overflow-hidden ring-1 ring-hairline rounded-card">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={(_, node) => onSelect(Number(node.id))}
        onNodeMouseEnter={(_, node) => setHover(Number(node.id))}
        onNodeMouseLeave={() => setHover(null)}
        fitView
        fitViewOptions={{ padding: 0.18 }}
        minZoom={0.3}
        maxZoom={1.5}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        zoomOnScroll={false}
        panOnScroll={false}
        preventScrolling={false}
        proOptions={{ hideAttribution: true }}
        className="bg-canvas-white"
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#1111110f" />
        <Panel position="top-right" className="!m-2">
          <ResetViewButton />
        </Panel>
      </ReactFlow>
    </div>
  );
}

function ResetViewButton() {
  const { fitView } = useReactFlow();
  return (
    <button
      type="button"
      onClick={() => void fitView({ padding: 0.18, duration: 300 })}
      title="Reset view"
      className="inline-flex cursor-pointer items-center gap-1 bg-canvas-white/90 px-2 py-1 text-caption font-medium text-midnight-ink ring-1 ring-hairline shadow-button transition-colors hover:bg-canvas-white rounded-button backdrop-blur-sm"
    >
      <Maximize2 className="size-3" strokeWidth={2.4} />
      Fit
    </button>
  );
}

function StepNode({ data }: NodeProps<Node<NodeData>>) {
  const { step, selected, dimmed } = data;
  return (
    <div
      // w-[196px] must match NODE_W (dagre lays out against that width).
      className={cn(
        "surface-panel flex w-[196px] items-center gap-2 px-2.5 py-2 ring-1 transition-all duration-200 rounded-card",
        selected ? "ring-deliver-green bg-canvas-white shadow-card" : "ring-hairline",
        !step.known && !selected && "ring-warning/60",
        dimmed && "opacity-35",
      )}
    >
      <Handle type="target" position={Position.Top} className="!size-1.5 !border-0 !bg-transparent" />
      <span className="inline-flex size-5 shrink-0 items-center justify-center bg-whisper-gray text-[10px] font-medium tabular-nums text-midnight-ink rounded-button">
        {step.index + 1}
      </span>
      <span className="inline-flex size-6 shrink-0 items-center justify-center bg-midnight-ink/[0.06] text-midnight-ink rounded-full">
        {stepIcon(step)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-mono text-caption leading-tight text-midnight-ink">{stepTitle(step)}</span>
        <span className="block truncate text-[10px] leading-tight text-muted-ash">{step.receiverLabel ?? step.receiverId}</span>
      </span>
      <Handle type="source" position={Position.Bottom} className="!size-1.5 !border-0 !bg-transparent" />
    </div>
  );
}

function computeLayout(steps: TxStep[]): Record<number, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "TB", nodesep: 30, ranksep: 44, marginx: 12, marginy: 12 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const s of steps) g.setNode(String(s.index), { width: NODE_W, height: NODE_H });
  for (const s of steps) if (s.after !== null) g.setEdge(String(s.after), String(s.index));
  dagre.layout(g);
  const pos: Record<number, { x: number; y: number }> = {};
  for (const s of steps) {
    const n = g.node(String(s.index));
    pos[s.index] = { x: n.x - NODE_W / 2, y: n.y - NODE_H / 2 };
  }
  return pos;
}
