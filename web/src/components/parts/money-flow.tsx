"use client";

// Money-flow graph (React Flow + dagre, left → right): where each token goes, protocol by protocol.
// Arrows are numbered with the plan step(s) they belong to; Rhea's node shows the net effect and the
// health factor before → after. Model: lib/flow-model.ts.

import { useMemo } from "react";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Handle,
  Position,
  MarkerType,
  type Node,
  type Edge,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import dagre from "@dagrejs/dagre";
import { ArrowLeftRight, Bot, Coins, Landmark, Send, Wallet } from "lucide-react";
import type { FlowNode, FlowNodeKind, MoneyFlow } from "@/lib/flow-model";
import { cn } from "@/lib/utils";

const NODE_W = 200;
const nodeH = (n: FlowNode) => 56 + (n.sub ? 0 : -14) + n.details.length * 17;

const ICON: Record<FlowNodeKind, typeof Wallet> = {
  wallet: Wallet,
  vault: Bot,
  wrap: Coins,
  ref: ArrowLeftRight,
  rhea: Landmark,
  recipient: Send,
};

const TONE: Record<FlowNodeKind, string> = {
  wallet: "bg-midnight-ink text-canvas-white",
  vault: "bg-midnight-ink text-canvas-white",
  wrap: "bg-midnight-ink/[0.07] text-midnight-ink",
  ref: "bg-brand-orange/15 text-brand-orange",
  rhea: "bg-brand-purple/15 text-brand-purple",
  recipient: "bg-destructive/15 text-destructive",
};

type Data = { n: FlowNode };
const nodeTypes = { flow: FlowNodeView };

export function MoneyFlowGraph({ flow, height = 240, className }: { flow: MoneyFlow; height?: number; className?: string }) {
  const { nodes, edges } = useMemo(() => {
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: "LR", nodesep: 26, ranksep: 120, marginx: 12, marginy: 12 });
    g.setDefaultEdgeLabel(() => ({}));
    for (const n of flow.nodes) g.setNode(n.id, { width: NODE_W, height: nodeH(n) });
    for (const e of flow.edges) g.setEdge(e.from, e.to);
    dagre.layout(g);
    const nodes: Node<Data>[] = flow.nodes.map((n) => {
      const p = g.node(n.id);
      return {
        id: n.id,
        type: "flow",
        position: { x: p.x - NODE_W / 2, y: p.y - nodeH(n) / 2 },
        data: { n },
        draggable: false,
        selectable: false,
        connectable: false,
      };
    });
    const edges: Edge[] = flow.edges.map((e) => ({
      id: e.id,
      source: e.from,
      target: e.to,
      type: "smoothstep",
      animated: true,
      label: `${e.steps.join("–")} · ${e.amount}`,
      labelStyle: { fontSize: 11, fontWeight: 600, fill: "#111111" },
      labelBgStyle: { fill: "#ffffff", fillOpacity: 0.95 },
      labelBgPadding: [6, 3] as [number, number],
      labelBgBorderRadius: 6,
      markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: e.estimate ? "#ee7b3d" : "#11111166" },
      style: { stroke: e.estimate ? "#ee7b3d" : "#11111166", strokeWidth: 1.6, strokeDasharray: e.estimate ? "5 4" : undefined },
    }));
    return { nodes, edges };
  }, [flow]);

  if (flow.nodes.length === 0) return null;
  return (
    // runtime-dynamic height (allowed inline-style carve-out)
    <div className={cn("w-full overflow-hidden ring-1 ring-hairline rounded-card", className)} style={{ height }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.12 }}
        minZoom={0.3}
        maxZoom={1.4}
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
      </ReactFlow>
    </div>
  );
}

function FlowNodeView({ data }: NodeProps<Node<Data>>) {
  const { n } = data;
  const Icon = ICON[n.kind];
  return (
    // w-[200px] must match NODE_W (dagre lays out against that width)
    <div className="surface-panel w-[200px] px-2.5 py-2 ring-1 ring-hairline rounded-card">
      <Handle type="target" position={Position.Left} className="!size-1.5 !border-0 !bg-transparent" />
      <div className="flex items-center gap-2">
        <span className={cn("inline-flex size-7 shrink-0 items-center justify-center rounded-full", TONE[n.kind])}>
          <Icon className="size-3.5" strokeWidth={2.4} />
        </span>
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block truncate text-caption font-medium text-midnight-ink">{n.title}</span>
          {n.sub && <span className="block truncate text-[10px] text-muted-ash">{n.sub}</span>}
        </span>
      </div>
      {n.details.length > 0 && (
        <div className="mt-1.5 space-y-0.5 border-t border-hairline/70 pt-1.5">
          {n.details.map((d) => (
            <div key={d} className="truncate text-[11px] tabular-nums text-midnight-ink">
              {d}
            </div>
          ))}
        </div>
      )}
      <Handle type="source" position={Position.Right} className="!size-1.5 !border-0 !bg-transparent" />
    </div>
  );
}
