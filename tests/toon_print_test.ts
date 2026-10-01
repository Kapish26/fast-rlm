import { assertEquals } from "jsr:@std/assert@^1.0.0";
import { loadPyodide } from "pyodide";
import {
  GRAPH_RUNTIME_PY,
  NEO4J_GRAPH_QUERY_PY,
  NEO4J_INSPECTION_PY,
  TOON_PRINT_PY,
} from "../src/graph.ts";

const pyodide = await loadPyodide();
await pyodide.loadPackage("micropip");
await pyodide.runPythonAsync(`
import micropip
await micropip.install(["networkx", "toon-format==0.9.0b1"])
`);
await pyodide.runPythonAsync(GRAPH_RUNTIME_PY);
await pyodide.runPythonAsync(TOON_PRINT_PY);
await pyodide.runPythonAsync(NEO4J_INSPECTION_PY);
await pyodide.runPythonAsync(NEO4J_GRAPH_QUERY_PY);

async function runJson(code: string): Promise<unknown> {
  const result = await pyodide.runPythonAsync(code);
  return JSON.parse(String(result));
}

Deno.test("TOON printer preserves scalar print semantics and encodes records", async () => {
  const result = await runJson(`
import contextlib
import io
import json
from toon_format import decode

_output = io.StringIO()
print(
    "records",
    [{"id": 1, "name": "Ada"}, {"id": 2, "name": "Bob"}],
    sep="|",
    end="!",
    file=_output,
    flush=True,
)
_text = _output.getvalue()
_toon = _text[len("records|"):-1]
json.dumps({"text": _text, "decoded": decode(_toon)})
`);
  assertEquals(result, {
    text: "records|[2]{id,name}:\n  1,Ada\n  2,Bob!",
    decoded: [{ id: 1, name: "Ada" }, { id: 2, name: "Bob" }],
  });
});

Deno.test("Neo4j print detects derived graphs beyond their first element", async () => {
  const result = await runJson(`
import contextlib
import io
import json
import networkx as nx
from toon_format import decode
_graph = nx.MultiDiGraph()
_graph.add_node("plain", properties={"name": "plain"})
_graph.add_node("internal", neo4j_element_id="internal", properties={"name": "Jamaica", "key": "jamaica-key"})
_output = io.StringIO()
with contextlib.redirect_stdout(_output):
    print(_graph)
_decoded = decode(_output.getvalue())
json.dumps({
    "name": _decoded["entities"][1]["name"],
    "contains_internal_id": "internal" in _output.getvalue(),
})
`);
  assertEquals(result, { name: "Jamaica", contains_internal_id: false });
});

Deno.test("Neo4j graph projection supports JSON when TOON is disabled", async () => {
  const result = await runJson(`
import contextlib
import io
import json
import networkx as nx
__graph_print_encoding__ = "json"
_graph = nx.MultiDiGraph()
_graph.add_node("internal", neo4j_element_id="internal", properties={"key": "jamaica-key"})
_output = io.StringIO()
with contextlib.redirect_stdout(_output):
    print(_graph)
__graph_print_encoding__ = "toon"
_decoded = json.loads(_output.getvalue())
json.dumps({
    "name": _decoded["entities"][0]["name"],
    "has_id": "id" in _decoded["entities"][0],
    "has_key": "key" in _decoded["entities"][0],
})
`);
  assertEquals(result, { name: "jamaica-key", has_id: false, has_key: false });
});

Deno.test("Neo4j graphs print compact TOON directly", async () => {
  const result = await runJson(`
import contextlib
import io
import json
import networkx as nx
from toon_format import decode

_graph = nx.MultiDiGraph()
_graph.graph["source_backend"] = "neo4j"
_graph.add_node(
    "n1", labels=["Entity"], neo4j_element_id="n1",
    properties={"name": "Jamaican English", "key": "k1"},
)
_graph.add_node(
    "n2", labels=["Entity"], neo4j_element_id="n2",
    properties={"name": "Jamaica", "key": "k2"},
)
_graph.add_edge(
    "n1", "n2", key="r1", neo4j_element_id="r1", relation="RELATED",
    properties={"predicate": "language.human_language.countries_spoken_in"},
)
_graph.graph["records"] = [
    {"entity": {"node": "n1"}, "score": 1.23456},
    {"entity": {"node": "n1"}},
]
__neo4j_print_role__ = "child"
_output = io.StringIO()
with contextlib.redirect_stdout(_output):
    print(_graph)
_decoded = decode(_output.getvalue())
globals().pop("__neo4j_print_role__", None)
json.dumps({
    "candidate": _decoded["candidates"][0],
    "source_name": _decoded["facts"][0]["source_name"],
    "target_name": _decoded["facts"][0]["target_name"],
    "predicate": _decoded["facts"][0]["predicate"],
    "has_keys": "keys" in _decoded,
    "has_relation": "relation" in _decoded["facts"][0],
    "contains_id": "n1" in _output.getvalue() or "r1" in _output.getvalue(),
    "contains_properties": "properties" in _output.getvalue(),
})
`);
  assertEquals(result, {
    candidate: { name: "Jamaican English", key: "k1", score: 1.2346 },
    source_name: "Jamaican English",
    target_name: "Jamaica",
    predicate: "language.human_language.countries_spoken_in",
    has_keys: false,
    has_relation: false,
    contains_id: false,
    contains_properties: false,
  });
});

Deno.test("Neo4j manual node and edge prints use registered display values", async () => {
  const result = await runJson(`
import contextlib
import io
import json
import networkx as nx

_graph = nx.MultiDiGraph(source_backend="neo4j")
_graph.add_node(
    "node-a", neo4j_element_id="node-a", labels=["WebQSPEntity"],
    properties={"name": "Jamaica", "key": "jamaica-key", "secret": "no"},
)
_graph.add_node(
    "node-b", neo4j_element_id="node-b", labels=["WebQSPEntity"],
    properties={"name": "Jamaican English", "key": "english-key"},
)
_graph.add_edge(
    "node-a", "node-b", key="rel-a", neo4j_element_id="rel-a",
    relation="RELATED", properties={"predicate": "languages_spoken", "secret": "no"},
)
__neo4j_register_graph__(_graph)

def _capture(_role):
    global __neo4j_print_role__
    __neo4j_print_role__ = _role
    _output = io.StringIO()
    with contextlib.redirect_stdout(_output):
        print("NODE", "node-a", dict(_graph.nodes["node-a"]))
        print(
            "EDGE", "node-a", "node-b", "rel-a",
            dict(_graph.edges["node-a", "node-b", "rel-a"]),
        )
        print({"ordinary": "value"})
    return _output.getvalue()

_child = _capture("child")
_root = _capture("root")
globals().pop("__neo4j_print_role__", None)
json.dumps({"child": _child, "root": _root})
`);
  const output = result as { child: string; root: string };
  for (const text of [output.child, output.root]) {
    assertEquals(text.includes("Jamaica"), true);
    assertEquals(text.includes("Jamaican English"), true);
    assertEquals(text.includes("languages_spoken"), true);
    assertEquals(text.includes("node-a"), false);
    assertEquals(text.includes("node-b"), false);
    assertEquals(text.includes("rel-a"), false);
    assertEquals(text.includes("labels"), false);
    assertEquals(text.includes("properties"), false);
    assertEquals(text.includes("secret"), false);
    assertEquals(text.includes("ordinary"), true);
    assertEquals(text.includes("value"), true);
  }
  assertEquals(output.child.includes("jamaica-key"), true);
  assertEquals(output.root.includes("jamaica-key"), false);
});

Deno.test("Neo4j graph_query automatically prints one root projection", async () => {
  const result = await runJson(`
import contextlib
import io
import json
from toon_format import decode

async def __js_graph_query__(_context, _instruction):
    return {
        "graph_query_id": "query-id",
        "artifact": {
            "version": 1,
            "backend": "networkx",
            "graph_type": "MultiDiGraph",
            "attributes": {"source_backend": "neo4j", "records": []},
            "nodes": [
                {"id": "node-a", "attributes": {
                    "neo4j_element_id": "node-a",
                    "properties": {"name": "Jamaica", "key": "jamaica-key"},
                }},
                {"id": "node-b", "attributes": {
                    "neo4j_element_id": "node-b",
                    "properties": {"name": "Jamaican English", "key": "english-key"},
                }},
            ],
            "edges": [{
                "source": "node-a", "target": "node-b", "key": "rel-a",
                "attributes": {
                    "neo4j_element_id": "rel-a", "relation": "RELATED",
                    "properties": {"predicate": "languages_spoken"},
                },
            }],
        },
    }

async def __js_graph_query_result__(*args):
    return None

__neo4j_print_role__ = "root"
_output = io.StringIO()
with contextlib.redirect_stdout(_output):
    _returned = await graph_query({"question": "test"})
_text = _output.getvalue()
_decoded = decode(_text)
globals().pop("__neo4j_print_role__", None)
json.dumps({
    "projection": _decoded,
    "returned_nodes": _returned.number_of_nodes(),
    "newline_count": _text.count("\\n"),
    "contains_id": any(_value in _text for _value in ("node-a", "node-b", "rel-a")),
})
`);
  const output = result as {
    projection: Record<string, unknown>;
    returned_nodes: number;
    newline_count: number;
    contains_id: boolean;
  };
  assertEquals(output.projection.counts, { nodes: 2, edges: 1, records: 0 });
  assertEquals(output.projection.facts, [{
    source_name: "Jamaica",
    predicate: "languages_spoken",
    target_name: "Jamaican English",
  }]);
  assertEquals("keys" in output.projection, false);
  assertEquals(output.returned_nodes, 2);
  assertEquals(output.contains_id, false);
  assertEquals(output.newline_count > 0, true);
});

Deno.test("Neo4j graph printing remains compact inside collections", async () => {
  const result = await runJson(`
import contextlib
import io
import json
import networkx as nx
from toon_format import decode

_graph = nx.MultiDiGraph()
_graph.add_node(
    "internal-id", neo4j_element_id="internal-id",
    properties={"name": "Jamaica", "key": "k1"},
)
_output = io.StringIO()
with contextlib.redirect_stdout(_output):
    print([_graph])
json.dumps({
    "contains_name": "Jamaica" in _output.getvalue(),
    "contains_internal_id": "internal-id" in _output.getvalue(),
})
`);
  assertEquals(result, { contains_name: true, contains_internal_id: false });
});

Deno.test("Neo4j views and copied tuples use the compact sanitizer", async () => {
  const result = await runJson(`
import contextlib
import io
import json
import networkx as nx
from toon_format import decode

_graph = nx.MultiDiGraph()
for _index in range(12):
    _graph.add_node(
        f"internal-{_index}", neo4j_element_id=f"internal-{_index}",
        properties={"name": f"Entity {_index}", "key": f"key-{_index}", "secret": "no"},
    )
for _index in range(11):
    _graph.add_edge(
        f"internal-{_index}", f"internal-{_index + 1}", key=f"rel-{_index}",
        neo4j_element_id=f"rel-{_index}", relation="RELATED",
        properties={"predicate": "connected"},
    )
__neo4j_print_role__ = "child"
def _printed(_value):
    _output = io.StringIO()
    with contextlib.redirect_stdout(_output):
        print(_value)
    return _output.getvalue(), decode(_output.getvalue())
_node_text, _nodes = _printed(_graph.nodes(data=True))
_edge_text, _edges = _printed(_graph.edges(keys=True, data=True))
_tuple_text, _tuples = _printed(list(_graph.nodes(data=True)))
_list_text, _values = _printed(list(range(25)))
globals().pop("__neo4j_print_role__", None)
json.dumps({
    "node_count": len(_nodes["entities"]),
    "edge_count": len(_edges["facts"]),
    "tuple_count": len(_tuples),
    "list_count": len(_values),
    "node_key": _nodes["entities"][0]["key"],
    "fact": _edges["facts"][0],
    "leaks": any("internal-" in _text or "secret" in _text or "properties" in _text
                 for _text in (_node_text, _edge_text, _tuple_text)),
})
`);
  assertEquals(result, {
    node_count: 10,
    edge_count: 10,
    tuple_count: 10,
    list_count: 10,
    node_key: "key-0",
    fact: {
      source_name: "Entity 0",
      predicate: "connected",
      target_name: "Entity 1",
    },
    leaks: false,
  });
});

Deno.test("Neo4j TOON and JSON use one byte-bounded projection", async () => {
  const result = await runJson(`
import json
import networkx as nx
_graph = nx.MultiDiGraph()
for _index in range(15):
    _graph.add_node(
        f"id-{_index}", neo4j_element_id=f"id-{_index}",
        properties={"name": "Entity " + str(_index) + " x" * 20, "key": f"key-{_index}"},
    )
for _index in range(14):
    _graph.add_edge(
        f"id-{_index}", f"id-{_index + 1}", key=f"rel-{_index}",
        neo4j_element_id=f"rel-{_index}", relation="RELATED",
        properties={"predicate": "long.relationship.predicate"},
    )
__neo4j_print_role__ = "child"
__neo4j_observation_bytes__ = 512
__graph_print_encoding__ = "toon"
_toon = __neo4j_graph_for_print__(_graph)
_toon_bytes = len(__neo4j_encoded_bytes__(_toon))
__graph_print_encoding__ = "json"
_json = __neo4j_graph_for_print__(_graph)
_json_bytes = len(__neo4j_encoded_bytes__(_json))
globals().pop("__neo4j_print_role__", None)
__graph_print_encoding__ = "toon"
json.dumps({
    "toon_counts": _toon["counts"], "json_counts": _json["counts"],
    "toon_bytes": _toon_bytes, "json_bytes": _json_bytes,
    "toon_truncated": bool(_toon.get("truncated")),
    "json_truncated": bool(_json.get("truncated")),
})
`);
  assertEquals(result, {
    toon_counts: { nodes: 15, edges: 14, records: 0 },
    json_counts: { nodes: 15, edges: 14, records: 0 },
    toon_bytes: (result as { toon_bytes: number }).toon_bytes,
    json_bytes: (result as { json_bytes: number }).json_bytes,
    toon_truncated: true,
    json_truncated: true,
  });
  const sizes = result as { toon_bytes: number; json_bytes: number };
  assertEquals(sizes.toon_bytes <= 512, true);
  assertEquals(sizes.json_bytes <= 512, true);
});

Deno.test("Neo4j fact projection cuts representative observation bytes by 40 percent", async () => {
  const result = await runJson(`
import json
import networkx as nx
from toon_format import encode
_graph = nx.MultiDiGraph()
_graph.add_node("seed", neo4j_element_id="seed", labels=["WebQSPEntity"],
                properties={"name": "Jamaica", "key": "jamaica"})
for _index in range(10):
    _node_id = f"answer-{_index}"
    _graph.add_node(
        _node_id, neo4j_element_id=_node_id, labels=["WebQSPEntity"],
        properties={"name": f"Jamaican language answer {_index}",
                    "key": f"jamaican-language-{_index}"},
    )
    _graph.add_edge(
        "seed", _node_id, key=f"relationship-{_index}",
        neo4j_element_id=f"relationship-{_index}", relation="RELATED",
        properties={"predicate": "location.country.languages_spoken"},
    )
_graph.graph["records"] = [{"node": {"node": "seed"}, "score": 1.0}]
__neo4j_print_role__ = "child"
_compact = neo4j_graph_snapshot(_graph)
_legacy_nodes = [
    {"name": _data["properties"]["name"], "key": _data["properties"]["key"]}
    for _, _data in list(_graph.nodes(data=True))[:10]
]
_legacy_edges = [
    {"source_name": _graph.nodes[_source]["properties"]["name"],
     "target_name": _graph.nodes[_target]["properties"]["name"],
     "predicate": _data["properties"]["predicate"], "relation": "RELATED"}
    for _source, _target, _key, _data in list(_graph.edges(keys=True, data=True))[:10]
]
_legacy = {
    "total_nodes": 11, "shown_nodes": 10, "nodes_truncated": True,
    "total_edges": 10, "shown_edges": 10, "edges_truncated": False,
    "total_records": 1, "shown_records": 1,
    "omitted_reference_records": 0, "records_truncated": False,
    "nodes": _legacy_nodes,
    "edges": _legacy_edges,
    "records": [{"node_name": "Jamaica", "node_key": "jamaica", "score": 1.0}],
}
_compact_bytes = len(encode(_compact, {"delimiter": ","}).encode("utf-8"))
_legacy_bytes = len(encode(_legacy, {"delimiter": ","}).encode("utf-8"))
globals().pop("__neo4j_print_role__", None)
json.dumps({
    "compact": _compact_bytes,
    "legacy": _legacy_bytes,
    "reduction": 1 - (_compact_bytes / _legacy_bytes),
})
`);
  const sizes = result as { compact: number; legacy: number; reduction: number };
  assertEquals(sizes.compact < sizes.legacy, true);
  assertEquals(sizes.reduction >= 0.4, true);
});

Deno.test("TOON printer bounds MultiDiGraph nodes, edges, and records", async () => {
  const result = await runJson(`
import contextlib
import io
import json
import networkx as nx
from toon_format import decode

_graph = nx.MultiDiGraph(source="test")
for _index in range(25):
    _graph.add_node(_index, name=f"node-{_index}")
for _index in range(19):
    _graph.add_edge(_index, _index + 1, key=f"edge-{_index}", relation="NEXT")
_graph.add_edge(0, 2, key="edge-extra", relation="EXTRA")
for _index in range(20, 25):
    _graph.add_edge(_index, (_index + 1) % 25, key=f"edge-{_index}", relation="HIDDEN")
_graph.graph["records"] = [{"value": _index} for _index in range(25)]

_output = io.StringIO()
with contextlib.redirect_stdout(_output):
    print(_graph)
_decoded = decode(_output.getvalue())
json.dumps({
    "graph_type": _decoded["graph_type"],
    "totals": [_decoded["total_nodes"], _decoded["total_edges"], _decoded["total_records"]],
    "shown": [_decoded["shown_nodes"], _decoded["shown_edges"], _decoded["shown_records"]],
    "truncated": [_decoded["nodes_truncated"], _decoded["edges_truncated"], _decoded["records_truncated"]],
    "first_edge_key": _decoded["edges"][0]["key"],
    "attributes": _decoded["graph_attributes"],
    "records_in_attributes": "records" in _decoded["graph_attributes"],
})
`);
  assertEquals(result, {
    graph_type: "MultiDiGraph",
    totals: [25, 25, 25],
    shown: [20, 20, 20],
    truncated: [true, true, true],
    first_edge_key: "edge-0",
    attributes: { source: "test" },
    records_in_attributes: false,
  });
});

Deno.test("TOON printer bounds NetworkX views and sanitizes cyclic values", async () => {
  const result = await runJson(`
import contextlib
import io
import json
import networkx as nx
from toon_format import decode

_graph = nx.Graph()
_graph.add_nodes_from((_index, {"rank": _index}) for _index in range(25))
_view_output = io.StringIO()
with contextlib.redirect_stdout(_view_output):
    print(_graph.nodes(data=True))
_view = decode(_view_output.getvalue())

_cyclic = []
_cyclic.append(_cyclic)
_cycle_output = io.StringIO()
with contextlib.redirect_stdout(_cycle_output):
    print(_cyclic)

json.dumps({
    "view_type": _view["view_type"],
    "total": _view["total_items"],
    "shown": _view["shown_items"],
    "truncated": _view["truncated"],
    "cycle": _cycle_output.getvalue(),
})
`);
  assertEquals(result, {
    view_type: "NodeDataView",
    total: 25,
    shown: 20,
    truncated: true,
    cycle: "[TOON encoding failed: list]\n",
  });
});

Deno.test("TOON printer supports graph kinds and common NetworkX views", async () => {
  const result = await runJson(`
import contextlib
import io
import json
import networkx as nx
from toon_format import decode

def _printed(_value):
    _output = io.StringIO()
    with contextlib.redirect_stdout(_output):
        print(_value)
    return decode(_output.getvalue())

_graph_types = []
for _class in (nx.Graph, nx.DiGraph, nx.MultiGraph, nx.MultiDiGraph):
    _graph = _class()
    _graph.add_edge("a", "b", relation="LINK")
    _decoded = _printed(_graph)
    _graph_types.append([
        _decoded["graph_type"],
        _decoded["directed"],
        _decoded["multigraph"],
    ])

_view_graph = nx.MultiDiGraph()
_view_graph.add_edge("a", "b", key="rel-1", relation="LINK")
json.dumps({
    "graphs": _graph_types,
    "edges": _printed(_view_graph.edges(keys=True, data=True)),
    "degree": _printed(_view_graph.degree),
    "adjacency": _printed(_view_graph.adj),
})
`);
  const parsed = result as Record<string, unknown>;
  assertEquals(parsed.graphs, [
    ["Graph", false, false],
    ["DiGraph", true, false],
    ["MultiGraph", false, true],
    ["MultiDiGraph", true, true],
  ]);
  assertEquals(
    (parsed.edges as { items: unknown[] }).items[0],
    {
      source: "a",
      target: "b",
      key: "rel-1",
      attributes: { relation: "LINK" },
    },
  );
  assertEquals((parsed.degree as { shown_items: number }).shown_items, 2);
  assertEquals((parsed.adjacency as { shown_items: number }).shown_items, 2);
});

Deno.test("TOON printer normalizes Pydantic-style models and Pyodide proxies", async () => {
  const result = await runJson(`
import contextlib
import io
import json
import sys
import types
from toon_format import decode

_pydantic = types.ModuleType("pydantic")
class _BaseModel:
    pass
_pydantic.BaseModel = _BaseModel
sys.modules["pydantic"] = _pydantic

class _Model(_BaseModel):
    def model_dump(self, mode=None):
        return {"kind": "model", "mode": mode}

class _Proxy:
    def to_py(self):
        return {"kind": "proxy", "values": [1, 2]}

def _printed(_value):
    _output = io.StringIO()
    with contextlib.redirect_stdout(_output):
        print(_value)
    return decode(_output.getvalue())

json.dumps({"model": _printed(_Model()), "proxy": _printed(_Proxy())})
`);
  assertEquals(result, {
    model: { kind: "model", mode: "json" },
    proxy: { kind: "proxy", values: [1, 2] },
  });
});
