import { assert, assertEquals } from "jsr:@std/assert@^1.0.0";
import { loadPyodide } from "pyodide";
import {
  GRAPH_RUNTIME_PY,
  graphFinalSetup,
  NEO4J_CYPHER_PY,
  NEO4J_INSPECTION_PY,
} from "../src/graph.ts";

const pyodide = await loadPyodide();
await pyodide.loadPackage("micropip");
await pyodide.runPythonAsync(`
import micropip
await micropip.install("networkx")
`);
await pyodide.runPythonAsync(GRAPH_RUNTIME_PY);
await pyodide.runPythonAsync(NEO4J_INSPECTION_PY);
await pyodide.runPythonAsync(NEO4J_CYPHER_PY);

Deno.test("Neo4j entity helpers build prefix search and rerank Ben Franklin", async () => {
  const result = await pyodide.runPythonAsync(`
import json

candidate_graph = nx.MultiDiGraph()
candidate_graph.add_node(
    "candidate-1",
    properties={"key": "person-1", "name": "Benjamin Franklin"},
)
candidate_graph.add_node(
    "candidate-2",
    properties={"key": "person-2", "name": "Ben Stiller"},
)
candidate_graph.graph["records"] = [
    {"node": {"node": "candidate-1"}, "score": 4.0},
    {"node": {"node": "candidate-2"}, "score": 2.0},
]

relation_graph = nx.MultiDiGraph()
relation_graph.add_node(
    "relation-candidate",
    properties={"key": "person-1", "name": "Benjamin Franklin"},
)
relation_graph.add_node(
    "answer",
    properties={"key": "answer-1", "name": "Bifocals"},
)
relation_graph.add_edge(
    "relation-candidate",
    "answer",
    key="related-1",
    relation="RELATED",
    properties={"predicate": "people.person.inventions"},
)

selected = find_neo4j_entity_seeds(
    candidate_graph,
    relation_graph,
    ["Ben Franklin"],
    ["invent"],
    min_confidence=0.75,
)
json.dumps({
    "query": build_fulltext_entity_query("Ben Franklin"),
    "queries": build_fulltext_entity_queries("Jamaican people"),
    "selected": selected,
    "source": __graph_runtime_seed_source__,
    "seeds": __graph_runtime_seeds__,
})
`);
  const parsed = JSON.parse(String(result));
  assertEquals(parsed.query, "ben* AND franklin*");
  assertEquals(parsed.queries, ["jamaican* AND people*", "jamaican~1"]);
  assertEquals(parsed.selected.length, 1);
  assertEquals(parsed.selected[0].key, "person-1");
  assertEquals(parsed.selected[0].name, "Benjamin Franklin");
  assertEquals(parsed.source, "neo4j_fulltext");
  assertEquals(parsed.seeds, ["Benjamin Franklin"]);
});

Deno.test("Neo4j fallback reranking matches Jamaican people to Jamaica", async () => {
  const result = await pyodide.runPythonAsync(`
import json
candidate_graph = nx.MultiDiGraph()
candidate_graph.add_node(
    "jamaica-node",
    properties={"key": "jamaica-key", "name": "Jamaica"},
)
candidate_graph.graph["records"] = [
    {"node": {"node": "jamaica-node"}, "score": 5.0},
]
selected = find_neo4j_entity_seeds(
    candidate_graph, nx.MultiDiGraph(), ["Jamaican people"],
    min_confidence=0.75,
)
json.dumps(selected)
`);
  const parsed = JSON.parse(String(result));
  assertEquals(parsed.length, 1);
  assertEquals(parsed[0].name, "Jamaica");
  assertEquals(parsed[0].key, "jamaica-key");
});

Deno.test("Neo4j graph snapshot exposes only compact display fields", async () => {
  const result = await pyodide.runPythonAsync(`
import json
snapshot_graph = nx.MultiDiGraph()
snapshot_graph.add_node(
    "n1", labels=["Entity"],
    properties={"name": "Jamaica", "key": "k1", "kind": "country"},
)
snapshot_graph.add_node("n2", labels=["Entity"], properties={"name": "Jamaican English"})
snapshot_graph.add_edge(
    "n1", "n2", key="r1", relation="RELATED", neo4j_element_id="rel-1",
    properties={"predicate": "language spoken"},
)
snapshot_graph.graph["records"] = [
    {"entity": {"node": "n1"}, "count": 1, "raw": {"secret": "no"}},
    {"edge": {"relationship": "rel-1"}},
]
snapshot_graph.graph["omitted_scalar_records"] = 2
__neo4j_print_role__ = "child"
json.dumps(neo4j_graph_snapshot(
    snapshot_graph, node_limit=1, edge_limit=1, record_limit=1
))
`);
  const parsed = JSON.parse(String(result));
  assertEquals(parsed.counts, { nodes: 2, edges: 1, records: 4 });
  assertEquals(parsed.facts, [{
    source_name: "Jamaica",
    predicate: "language spoken",
    target_name: "Jamaican English",
  }]);
  assertEquals(parsed.keys, [{ name: "Jamaica", key: "k1" }]);
  assertEquals(parsed.omitted_scalar_records, 2);
  assertEquals(parsed.hint.includes("Return Neo4j graph values"), true);
  assertEquals(JSON.stringify(parsed).includes("secret"), false);
  assertEquals(JSON.stringify(parsed).includes("rel-1"), false);
});

Deno.test("Neo4j entity helper rejects empty mentions", async () => {
  const result = await pyodide.runPythonAsync(`
error_message = None
try:
    build_fulltext_entity_query(" -- ")
except ValueError as error:
    error_message = str(error)
error_message
`);
  assertEquals(String(result), "entity mention must contain at least one word");
});

Deno.test("automatic Neo4j projection omits internal identifiers and bounds bytes", async () => {
  const result = await pyodide.runPythonAsync(`
import json
_graph = nx.MultiDiGraph()
_graph.add_node("internal-a", properties={"name": "Jamaica", "key": "jamaica-key", "secret": "no"})
_graph.add_node("internal-b", properties={"name": "Jamaican English", "key": "english-key"})
_graph.add_edge("internal-a", "internal-b", key="rel-internal", properties={"predicate": "language"}, relation="RELATED")
__neo4j_observation_bytes__ = 220
_projection = __neo4j_graph_for_print__(_graph)
_output = json.dumps(_projection)
json.dumps({
    "output": _output,
    "truncated": bool(_projection.get("truncated")),
    "bytes": len(__neo4j_encoded_bytes__(_projection)),
})
`);
  const parsed = JSON.parse(String(result));
  assertEquals(parsed.output.includes("internal-a"), false);
  assertEquals(parsed.output.includes("secret"), false);
  assert(parsed.bytes <= 220);
});

Deno.test("documented Neo4j selection preserves nested Jamaica multiedges", async () => {
  await pyodide.runPythonAsync(graphFinalSetup(true, 4, true));
  const result = await pyodide.runPythonAsync(`
import json
evidence_graph.clear()
evidence_graph.graph.update({"source_backend": "neo4j", "records": [], "truncated": False})
evidence_graph.add_node(
    "jamaica", neo4j_element_id="jamaica",
    properties={"key": "Jamaica", "name": "Jamaica"},
)
evidence_graph.add_node(
    "english", neo4j_element_id="english",
    properties={"key": "Jamaican English", "name": "Jamaican English"},
)
evidence_graph.add_node(
    "creole", neo4j_element_id="creole",
    properties={
        "key": "Jamaican Creole English Language",
        "name": "Jamaican Creole English Language",
    },
)
evidence_graph.add_edge(
    "jamaica", "english", key="rel-official",
    neo4j_element_id="rel-official", relation="RELATED", type="RELATED",
    properties={"predicate": "location.country.official_language"},
)
evidence_graph.add_edge(
    "jamaica", "english", key="rel-spoken",
    neo4j_element_id="rel-spoken", relation="RELATED", type="RELATED",
    properties={"predicate": "location.country.languages_spoken"},
)
evidence_graph.add_edge(
    "jamaica", "creole", key="rel-creole",
    neo4j_element_id="rel-creole", relation="RELATED", type="RELATED",
    properties={"predicate": "location.country.languages_spoken"},
)

relevant_predicates = {
    "location.country.official_language",
    "location.country.languages_spoken",
}
relevant_source_names = {"Jamaica"}
selected_edges = []
for u, v, key, data in evidence_graph.edges(keys=True, data=True):
    predicate = data.get("properties", {}).get("predicate")
    source_name = evidence_graph.nodes[u].get("properties", {}).get("name")
    if predicate in relevant_predicates and source_name in relevant_source_names:
        selected_edges.append((u, v, key))
answer_graph = evidence_graph.edge_subgraph(selected_edges).copy()
GRAPH_FINAL(answer_graph)

json.dumps({
    "selected": len(selected_edges),
    "nodes": sorted(
        node["attributes"]["properties"]["name"]
        for node in __graph_final_result__["nodes"]
    ),
    "keys": sorted(edge["key"] for edge in __graph_final_result__["edges"]),
    "predicates": sorted(
        edge["attributes"]["properties"]["predicate"]
        for edge in __graph_final_result__["edges"]
    ),
    "has_top_level_predicate": any(
        "predicate" in edge["attributes"]
        for edge in __graph_final_result__["edges"]
    ),
})
`);
  const parsed = JSON.parse(String(result));
  assertEquals(parsed.selected, 3);
  assertEquals(parsed.nodes, [
    "Jamaica",
    "Jamaican Creole English Language",
    "Jamaican English",
  ]);
  assertEquals(parsed.keys, ["rel-creole", "rel-official", "rel-spoken"]);
  assertEquals(parsed.predicates, [
    "location.country.languages_spoken",
    "location.country.languages_spoken",
    "location.country.official_language",
  ]);
  assertEquals(parsed.has_top_level_predicate, false);
});

Deno.test("Neo4j GRAPH_FINAL recovers authentic lost multiedge keys", async () => {
  await pyodide.runPythonAsync(graphFinalSetup(true, 4, true));
  const result = await pyodide.runPythonAsync(`
import json
evidence_graph.clear()
evidence_graph.graph.update({"source_backend": "neo4j", "records": [{"count": 3}], "truncated": False})
evidence_graph.add_node("jamaica", properties={"key": "jamaica-key", "name": "Jamaica"})
evidence_graph.add_node("english", properties={"key": "english-key", "name": "Jamaican English"})
evidence_graph.add_node("creole", properties={"key": "creole-key", "name": "Jamaican Creole English Language"})
evidence_graph.add_edge(
    "jamaica", "english", key="rel-official",
    neo4j_element_id="rel-official", relation="RELATED",
    properties={"predicate": "location.country.official_language"},
)
evidence_graph.add_edge(
    "jamaica", "english", key="rel-spoken",
    neo4j_element_id="rel-spoken", relation="RELATED",
    properties={"predicate": "location.country.languages_spoken"},
)
evidence_graph.add_edge(
    "jamaica", "creole", key="rel-creole",
    neo4j_element_id="rel-creole", relation="RELATED",
    properties={"predicate": "location.country.languages_spoken"},
)

# This is the failed live-run shape: copying without keys assigns local 0/1 keys.
_answer = nx.MultiDiGraph()
for _source, _target, _data in evidence_graph.edges(data=True):
    _answer.add_edge(_source, _target, forged=True, **dict(_data))
_answer.nodes["jamaica"]["forged"] = True
_answer.graph["facts"] = [{"name": "count", "value": 3}]
GRAPH_FINAL(_answer)
_artifact = __graph_final_result__
json.dumps({
    "keys": sorted(_edge["key"] for _edge in _artifact["edges"]),
    "edge_attrs": [_edge["attributes"] for _edge in _artifact["edges"]],
    "node_attrs": [_node["attributes"] for _node in _artifact["nodes"]],
    "facts": _artifact["attributes"]["facts"],
})
`);
  const parsed = JSON.parse(String(result));
  assertEquals(parsed.keys, ["rel-creole", "rel-official", "rel-spoken"]);
  assertEquals(
    parsed.edge_attrs.every((attrs: Record<string, unknown>) => attrs.forged === undefined),
    true,
  );
  assertEquals(
    parsed.node_attrs.every((attrs: Record<string, unknown>) => attrs.forged === undefined),
    true,
  );
  assertEquals(parsed.facts, [{ name: "count", value: 3 }]);
});

Deno.test("Neo4j GRAPH_FINAL rejects unsupported and duplicate edge provenance", async () => {
  const result = await pyodide.runPythonAsync(`
import json

def _rejection(graph):
    try:
        GRAPH_FINAL(graph)
    except ValueError as error:
        return str(error)
    return None

_exact = evidence_graph.edge_subgraph([
    ("jamaica", "english", "rel-official"),
]).copy()
_exact.edges["jamaica", "english", "rel-official"]["forged"] = True
GRAPH_FINAL(_exact)
_exact_artifact = __graph_final_result__

_missing_id = nx.MultiDiGraph()
_missing_id.add_edge(
    "jamaica", "english", key=0, relation="RELATED",
    properties={"predicate": "location.country.official_language"},
)

_fabricated_id = nx.MultiDiGraph()
_fabricated_id.add_edge(
    "jamaica", "english", key=0, neo4j_element_id="fabricated",
)

_wrong_endpoints = nx.MultiDiGraph()
_wrong_endpoints.add_edge(
    "jamaica", "creole", key=0, neo4j_element_id="rel-official",
)

_duplicate = nx.MultiDiGraph()
_duplicate.add_edge(
    "jamaica", "english", key="rel-official",
    neo4j_element_id="rel-official",
)
_duplicate.add_edge(
    "jamaica", "english", key=0,
    neo4j_element_id="rel-official",
)

_results = {
    "exact_key": _exact_artifact["edges"][0]["key"],
    "exact_attrs": _exact_artifact["edges"][0]["attributes"],
    "missing_id": _rejection(_missing_id),
    "fabricated_id": _rejection(_fabricated_id),
    "wrong_endpoints": _rejection(_wrong_endpoints),
    "duplicate": _rejection(_duplicate),
    "category_after_duplicate": __graph_final_error__,
    "result_set_after_duplicate": __graph_final_result_set__,
}
GRAPH_FINAL(_exact)
_results["category_after_success"] = __graph_final_error__
json.dumps(_results)
`);
  const parsed = JSON.parse(String(result));
  assertEquals(parsed.exact_key, "rel-official");
  assertEquals(parsed.exact_attrs.forged, undefined);
  assertEquals(parsed.missing_id, "final_graph_rejected: unknown_edge");
  assertEquals(parsed.fabricated_id, "final_graph_rejected: unknown_edge");
  assertEquals(parsed.wrong_endpoints, "final_graph_rejected: unknown_edge");
  assertEquals(parsed.duplicate, "final_graph_rejected: duplicate_edge");
  assertEquals(parsed.category_after_duplicate, "duplicate_edge");
  assertEquals(parsed.result_set_after_duplicate, false);
  assertEquals(parsed.category_after_success, null);
});

Deno.test("Neo4j GRAPH_FINAL exposes only fixed rejection categories", async () => {
  const result = await pyodide.runPythonAsync(`
import json

def _category(graph):
    try:
        GRAPH_FINAL(graph)
    except ValueError:
        return __graph_final_error__
    return None

_unknown_node = nx.MultiDiGraph()
_unknown_node.add_node("database-secret")

_bad_fact = nx.MultiDiGraph()
_bad_fact.graph["facts"] = [{"name": "count", "value": 4}]

_records = nx.MultiDiGraph()
_records.graph["records"] = [{"secret": "database text"}]

json.dumps({
    "wrong_type": _category(nx.DiGraph()),
    "unknown_node": _category(_unknown_node),
    "facts": _category(_bad_fact),
    "records": _category(_records),
})
`);
  assertEquals(JSON.parse(String(result)), {
    wrong_type: "wrong_type",
    unknown_node: "unknown_node",
    facts: "facts",
    records: "records",
  });
});

Deno.test("full-text reads automatically record considered seed names", async () => {
  const result = await pyodide.runPythonAsync(`
__graph_runtime_seed_candidates__ = []
__graph_runtime_candidate_count__ = 0
__neo4j_seed_names_seen__.clear()

async def __js_execute_read_only_cypher__(query, parameters, limit):
    return {"budget": {"attempts_used": 1, "attempts_remaining": 4}, "artifact": {
        "version": 1,
        "backend": "networkx",
        "graph_type": "MultiDiGraph",
        "attributes": {
            "records": [{"name": "Jamaica"}, {"name": "Jamaican Senate"}],
            "truncated": False,
        },
        "nodes": [],
        "edges": [],
    }}

await execute_read_only_cypher(
    "CALL db.index.fulltext.queryNodes('entities', $entity_query) "
    "YIELD node RETURN node"
)
json.dumps({
    "count": __graph_runtime_candidate_count__,
    "candidates": __graph_runtime_seed_candidates__,
})
`);
  const parsed = JSON.parse(String(result));
  assertEquals(parsed.count, 2);
  assertEquals(
    parsed.candidates.map((candidate: { name: string }) => candidate.name),
    ["Jamaica", "Jamaican Senate"],
  );
});

Deno.test("Cypher reads accumulate while returning individual graphs", async () => {
  const result = await pyodide.runPythonAsync(`
import json
import contextlib
import io
evidence_graph.clear()
evidence_graph.graph.update({"records": [], "truncated": False})
_responses = iter([
    {"budget": {"attempts_used": 1, "attempts_remaining": 4}, "artifact": {
        "version": 1, "backend": "networkx", "graph_type": "MultiDiGraph",
        "attributes": {"records": [{"value": "first-secret"}], "truncated": False},
        "nodes": [
            {"id": "shared", "attributes": {"properties": {"name": "Concrete Name"}}},
            {"id": "answer", "attributes": {}},
        ],
        "edges": [{"source": "shared", "target": "answer", "key": "rel-1", "attributes": {}}],
    }},
    {"budget": {"attempts_used": 2, "attempts_remaining": 3}, "artifact": {
        "version": 1, "backend": "networkx", "graph_type": "MultiDiGraph",
        "attributes": {"records": [{"value": "second-secret"}], "truncated": True},
        "nodes": [{"id": "shared", "attributes": {"placeholder": True}}],
        "edges": [{"source": "shared", "target": "answer", "key": "rel-1", "attributes": {}}],
    }},
])
async def __js_execute_read_only_cypher__(query, parameters, limit):
    return next(_responses)
_output = io.StringIO()
with contextlib.redirect_stdout(_output):
    first = await execute_read_only_cypher("RETURN 1")
    second = await execute_read_only_cypher("RETURN 2")
json.dumps({
    "first_nodes": sorted(first.nodes),
    "second_nodes": sorted(second.nodes),
    "accumulated_nodes": sorted(evidence_graph.nodes),
    "accumulated_edges": evidence_graph.number_of_edges(),
    "shared": dict(evidence_graph.nodes["shared"]),
    "records": evidence_graph.graph["records"],
    "truncated": evidence_graph.graph["truncated"],
    "receipt": _output.getvalue(),
})
`);
  const parsed = JSON.parse(String(result));
  assertEquals(parsed.first_nodes, ["answer", "shared"]);
  assertEquals(parsed.second_nodes, ["answer", "shared"]);
  assertEquals(parsed.accumulated_nodes, ["answer", "shared"]);
  assertEquals(parsed.accumulated_edges, 1);
  assertEquals(parsed.shared.properties.name, "Concrete Name");
  assertEquals(parsed.records, [
    { value: "first-secret" }, { value: "second-secret" },
  ]);
  assertEquals(parsed.truncated, true);
  assertEquals(parsed.receipt.includes("first-secret"), false);
  assertEquals(parsed.receipt.includes("Concrete Name"), false);
  assertEquals(parsed.receipt.includes("result rows=1"), true);
  assertEquals(parsed.receipt.includes("accumulated rows=2"), true);
  assertEquals(parsed.receipt.includes("attempts used=2, remaining=3"), true);
});

Deno.test("failed Cypher reads leave accumulated evidence unchanged", async () => {
  const result = await pyodide.runPythonAsync(`
import json
before = (evidence_graph.number_of_nodes(), evidence_graph.number_of_edges(), list(evidence_graph.graph["records"]))
async def __js_execute_read_only_cypher__(query, parameters, limit):
    raise RuntimeError("database failure")
try:
    await execute_read_only_cypher("RETURN 3")
except RuntimeError:
    pass
after = (evidence_graph.number_of_nodes(), evidence_graph.number_of_edges(), list(evidence_graph.graph["records"]))
json.dumps({"unchanged": before == after})
`);
  assertEquals(JSON.parse(String(result)), { unchanged: true });
});
