import os
from typing import Optional
import requests
from mcp.server.fastmcp import FastMCP

PLANNING_API_BASE = "https://www.planning.data.gov.uk"

mcp = FastMCP(
    "Vanor Planning Data API",
    instructions=(
        "Use this server to search official England planning datasets, "
        "including conservation areas, listed buildings, flood risk zones, "
        "Article 4 areas, green belt, brownfield land and planning applications."
    ),
    stateless_http=True,
    json_response=True,
    host="0.0.0.0",
    port=int(os.environ.get("PORT", "8000")),
)

def planning_get(path: str, params: list[tuple[str, str | int | float]]) -> dict:
    response = requests.get(
        f"{PLANNING_API_BASE}{path}",
        params=params,
        timeout=30,
    )
    response.raise_for_status()
    return response.json()

@mcp.tool()
def check_site_constraints(
    latitude: Optional[float] = None,
    longitude: Optional[float] = None,
    q: Optional[str] = None,
    limit: int = 100,
) -> dict:
    """
    Check planning constraints for a site using either latitude/longitude or q.
    q can be a postcode or UPRN.
    """
    if not q and (latitude is None or longitude is None):
        return {
            "error": "Provide either q as a postcode/UPRN or both latitude and longitude."
        }
    
    datasets = [
        "conservation-area",
        "listed-building",
        "scheduled-monument",
        "flood-risk-zone",
        "article-4-direction-area",
        "green-belt",
        "tree-preservation-zone",
        "heritage-at-risk",
        "site-of-special-scientific-interest",
        "ancient-woodland",
    ]
    
    params: list[tuple[str, str | int | float]] = []
    if q:
        params.append(("q", q))
    else:
        params.append(("latitude", latitude))
        params.append(("longitude", longitude))
        
    for dataset in datasets:
        params.append(("dataset", dataset))
        
    params.extend(
        [
            ("limit", limit),
            ("field", "entity"),
            ("field", "name"),
            ("field", "dataset"),
            ("field", "reference"),
            ("field", "listed_building_grade"),
            ("field", "start-date"),
        ]
    )
    
    data = planning_get("/entity.json", params)
    return {
        "constraints": data.get("entities", []),
        "warning": (
            "No results does not guarantee no constraints exist. "
            "Planning Data coverage varies by dataset and location."
        ),
    }

@mcp.tool()
def search_planning_applications(
    q: str,
    limit: int = 20,
) -> dict:
    """
    Search planning applications using a postcode, UPRN, address fragment or keyword.
    """
    params = [
        ("dataset", "planning-application"),
        ("q", q),
        ("limit", limit),
    ]
    data = planning_get("/entity.json", params)
    return {
        "applications": data.get("entities", []),
        "warning": (
            "Planning-application coverage is not complete across all authorities, "
            "so absence of results does not prove absence of planning history."
        ),
    }

@mcp.tool()
def find_local_planning_authorities(limit: int = 500) -> dict:
    """
    List local planning authorities and their Planning Data entity IDs.
    Use this before searching brownfield land by LPA.
    """
    params = [
        ("dataset", "local-planning-authority"),
        ("limit", limit),
        ("field", "entity"),
        ("field", "name"),
    ]
    data = planning_get("/entity.json", params)
    return {
        "local_planning_authorities": data.get("entities", []),
    }

@mcp.tool()
def find_brownfield_sites(
    local_planning_authority_entity: int,
    limit: int = 100,
) -> dict:
    """
    Find brownfield land sites within a local planning authority.
    Requires the LPA entity ID.
    """
    params = [
        ("dataset", "brownfield-land"),
        ("geometry_entity", local_planning_authority_entity),
        ("geometry_relation", "within"),
        ("limit", limit),
    ]
    data = planning_get("/entity.json", params)
    return {
        "brownfield_sites": data.get("entities", []),
    }

@mcp.tool()
def get_planning_entity(entity_id: int) -> dict:
    """
    Fetch one Planning Data entity by entity ID.
    """
    return planning_get(f"/entity/{entity_id}.json", [])

if __name__ == "__main__":
    mcp.run(transport="sse")
