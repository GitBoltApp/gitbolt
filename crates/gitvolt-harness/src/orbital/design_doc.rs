//! Orbital's game design document as data: the early design (v1) and its revision (v2).

use super::{art, scenes};
use crate::media::layout::*;

pub fn pdf(version: u16) -> Vec<u8> {
    render(&design_doc(version))
}

pub fn design_doc(version: u16) -> Doc {
    let v2 = version >= 2;
    let mut b = Vec::new();

    b.push(Block::H1("Overview".into()));
    b.push(para("Orbital is a two-dimensional space-trading game about orbits, cargo and the slow arithmetic of fuel. The player flies a small ship between stations that circle one star. Each station buys and sells a different mix of goods, and each route burns a different amount of fuel, so every screen asks the same question: what to carry, and when to leave."));
    b.push(para(if v2 {
        "This revision (0.7) rewrites the economy, adds the Contracts chapter and replaces the numbers the first draft set by guesswork. What stays is the skeleton: orbital flight, the core loop and the art direction. Where a number has changed, the table says so in its caption."
    } else {
        "The game is for players who liked the quiet parts of trading games: planning a route on paper, watching prices move, learning a ship well enough to trust it. It is not a combat game. Combat exists so that the map has consequences, and nothing more."
    }));
    b.push(Block::Callout(if v2 {
        "The pitch in one line: fly a small ship between orbits, take the contracts that pay, and keep the prices honest.".into()
    } else {
        "The pitch in one line: fly a small ship between orbits, carry whatever pays, and try not to run dry in the dark.".into()
    }));

    b.push(Block::H1("Core loop".into()));
    b.push(para("Every session is the same four steps, and each one makes the next more interesting. Fly to a station. Trade what you carry. Spend the profit on the ship or its fittings. Then explore a route you could not reach before."));
    b.push(Block::Diagram(loop_diagram()));
    if v2 {
        b.push(para("The loop has a shortcut in its second step. A contract offers a fixed reward for one delivery, which is what a new player does first with a full hold, and it teaches the route before the market does."));
    }

    b.push(Block::H1("Orbital flight".into()));
    b.push(para("Ships never fly in straight lines. Thrust changes your orbit, and the orbit decides where you'll be. The map shows the path your ship will follow if you do nothing, and how a burn would bend it."));
    b.push(Block::Diagram(Diagram {
        height: 190.0,
        caption: "A transfer between two circular orbits: burn prograde at A, coast half an orbit, burn again at B".into(),
        shapes: vec![
            Shape::Disc { cx: 233.0, cy: 95.0, r: 22.0, colour: TEAL },
            Shape::Ellipse { cx: 233.0, cy: 95.0, rx: 60.0, ry: 60.0, colour: MUTED, dashed: false },
            Shape::Ellipse { cx: 233.0, cy: 95.0, rx: 150.0, ry: 80.0, colour: MUTED, dashed: false },
            Shape::Ellipse { cx: 278.0, cy: 95.0, rx: 105.0, ry: 70.0, colour: GOLD, dashed: true },
            Shape::Disc { cx: 173.0, cy: 95.0, r: 4.0, colour: RED },
            Shape::Label { x: 150.0, y: 90.0, text: "A".into(), size: 10.0, colour: INK, bold: true },
            Shape::Disc { cx: 383.0, cy: 95.0, r: 4.0, colour: RED },
            Shape::Label { x: 390.0, y: 90.0, text: "B".into(), size: 10.0, colour: INK, bold: true },
            Shape::Arrow { from: (173.0, 150.0), to: (173.0, 110.0), colour: GOLD },
        ],
    }));
    b.push(para(if v2 {
        "A burn at the wrong point of the orbit moves you onto a path that meets a station on the far side of the star, a long way from where you meant to be. Burns are cheap in fuel and expensive in time, so the game makes the player plan them, not spam them."
    } else {
        "Burns are measured in kilonewtons and cost fuel in proportion. A burn at the wrong point of the orbit moves you onto a path that meets a station on the far side of the star, which is the most common way to lose a day."
    }));
    b.push(Block::H2("Controls".into()));
    b.push(para("The default bindings are chosen so that one hand stays on the thrust keys and the other on the menus. Every binding can be changed in the settings."));
    b.push(table(
        vec![col("Key", 0.2, false), col("Action", 0.8, false)],
        vec![
            row(&["W / S", "Thrust prograde and retrograde"]),
            row(&["A / D", "Rotate left and right"]),
            row(&["Q / E", "Thrust radially in and out"]),
            row(&["M", "Open the map"]),
            row(&["Space", "Dock or undock at a station in range"]),
            row(&["Tab", "Cycle cargo and fittings"]),
            row(&["F", "Fire the mining laser (Miner only)"]),
        ],
        "Default controls",
    ));

    b.push(Block::H1("Ships".into()));
    b.push(para(if v2 {
        "There are six ship classes. Each has one job it does better than the others, and a role column now says which. The numbers below are the revision's."
    } else {
        "There are six ship classes. Each one does a single job better than the others, and the design is only right if no ship is the obvious choice for everything. The numbers are first-draft estimates, to be tuned in the playtest."
    }));
    let stats: [[&str; 5]; 6] = if v2 {
        [["4", "1", "95", "2", "12,500"], ["18", "26", "60", "8", "88,000"], ["9", "0", "260", "3", "71,000"], ["22", "18", "45", "10", "99,000"], ["7", "6", "165", "4", "61,000"], ["60", "96", "30", "25", "325,000"]]
    } else {
        [["4", "1", "90", "2", "12,000"], ["18", "24", "60", "8", "84,000"], ["9", "0", "240", "3", "65,000"], ["22", "16", "45", "10", "96,000"], ["7", "6", "150", "4", "58,000"], ["60", "90", "30", "25", "310,000"]]
    };
    let roles = ["Surveys, short couriers", "Bulk cargo", "Escort and pursuit", "Ore runs", "Fast contracts", "Deep bulk"];
    let mut columns = vec![col("Class", 0.18, false)];
    if v2 {
        columns.push(col("Role", 0.26, false));
    }
    columns.extend([col("Mass (t)", 0.11, true), col("Cargo (t)", 0.12, true), col("Thrust (kN)", 0.13, true), col("Fuel (t)", 0.1, true), col("Price (cr)", 0.14, true)]);
    let ship_rows = art::SHIPS
        .iter()
        .zip(stats)
        .enumerate()
        .map(|(i, (name, s))| {
            let mut cells = vec![title_case(name)];
            if v2 {
                cells.push(roles[i].into());
            }
            cells.extend(s.iter().map(|c| c.to_string()));
            cells
        })
        .collect();
    b.push(Block::Table(Table { columns, rows: ship_rows, caption: if v2 { "Ship classes, revision 0.7".into() } else { "Ship classes, first draft".into() } }));
    b.push(para(if v2 {
        "Upgrades are fitted at docks and take cargo space, so a faster ship is also a smaller one. The interceptor gained thrust in this revision because pursuit was the only role that felt slow."
    } else {
        "Upgrades are fitted at docks. Every fitting takes cargo space, so a faster ship is also a smaller one, and the trade-off is the point of the class."
    }));

    b.push(Block::H1("Economy".into()));
    if v2 {
        economy_v2(&mut b);
    } else {
        economy_v1(&mut b);
    }

    b.push(Block::H1("Stations".into()));
    b.push(para("Three stations orbit the star. Each is a small world with its own prices, its own faction and its own reason to be visited."));
    let board = if v2 { "Bulletin board: rumours, warnings and contracts" } else { "Bulletin board: rumours and warnings" };
    b.push(bullets(&["Refuel: fuel cells at the station price, with a discount for full tanks", "Repair: hull and thruster repair, priced by the damage done", "Dock and trade: the market, with a list of goods the station is short of", "Upgrades: fittings for the ship in the bay", board]));
    if v2 {
        b.push(table(
            vec![col("Station", 0.2, false), col("Orbit (AU)", 0.14, true), col("Services", 0.36, false), col("Faction", 0.3, false)],
            vec![row(&["Kestrel Ring", "1.00", "Trade, refuel, contracts", "Ring Concord"]), row(&["Halden Depot", "1.35", "Trade, repair, upgrades", "Halden Guild"]), row(&["Outpost Vire", "2.10", "Refuel, contracts, fittings", "Vire Independents"])],
            "The three stations, revision 0.7",
        ));
    } else {
        b.push(table(
            vec![col("Station", 0.2, false), col("Orbit (AU)", 0.14, true), col("Services", 0.36, false), col("Faction", 0.3, false)],
            vec![row(&["Kestrel Ring", "1.00", "Trade, refuel", "Ring Concord"]), row(&["Halden Depot", "1.35", "Trade, repair, upgrades", "Halden Guild"]), row(&["Outpost Vire", "2.10", "Refuel, fittings", "Vire Independents"])],
            "The three stations, first draft",
        ));
    }

    if v2 {
        b.push(Block::H1("Contracts".into()));
        b.push(para("A contract is a promise to carry one kind of cargo from one station to another by a deadline. The station that offers it names the cargo, the reward and the days allowed. Accepting it locks the reward in, and the player loads the cargo at the origin dock before the clock is measured from there."));
        b.push(Block::Diagram(contract_diagram()));
        b.push(para("A delivered contract pays its reward in full. A failed one, by deadline or by a lost hold, pays nothing and damages the station's standing with its faction, which is what keeps contract routes from being abandoned in the middle of a run."));
        b.push(table(
            vec![col("Type", 0.26, false), col("Cargo", 0.24, false), col("Reward (cr)", 0.2, true), col("Deadline (days)", 0.3, true)],
            vec![row(&["Medical run", "Medkits", "2,400", "6"]), row(&["Ore consignment", "Iron ore", "3,900", "10"]), row(&["Fuel for the dark", "Fuel cells", "1,800", "4"]), row(&["Reactor swap", "Reactor parts", "7,500", "12"]), row(&["Circuitry rush", "Circuitry", "5,200", "5"])],
            "Contract types and rewards",
        ));
    }

    b.push(Block::H1("Art direction".into()));
    b.push(para("Everything is pixel art on a 32-colour palette, drawn at native size and shown at integer scale. Outlines are selective: a ship keeps a dark edge where it meets the void and loses it where it meets another part of itself, so the sprites read at a glance."));
    b.push(Block::Diagram(palette_diagram()));
    b.push(para("The title screen is the first thing a player sees and the cover of this document. It uses the same five lane colours as the palette, so a screenshot never fights the logo."));
    b.push(Block::Image { canvas: scenes::title(version), scale: 0.9, caption: format!("The title screen, version {}", if v2 { "0.7" } else { "0.4" }) });

    b.push(Block::H1("Roadmap".into()));
    b.push(para(if v2 {
        "The schedule slipped by a quarter after the first playtest, and the revision moves the dates to match. The two new rows are the Contracts milestone and a multiplayer experiment, which is a question, not a commitment."
    } else {
        "The roadmap ends at the alpha. Every milestone is a playable build the team can show someone outside it, and each one has a single theme."
    }));
    b.push(if v2 {
        table(
            vec![col("Milestone", 0.3, false), col("Target", 0.2, false), col("Scope", 0.5, false)],
            vec![
                row(&["v0.5 Alpha", "2025-06", "Full economy, eight commodities, three stations"]),
                row(&["v0.6 Economy rework", "2025-08", "Supply and demand, elasticity, price shocks"]),
                row(&["v0.7 Contracts", "2025-11", "This revision: contracts, new ship numbers"]),
                row(&["Multiplayer experiment", "2026-Q1", "Shared markets, a prototype only"]),
                row(&["v1.0 Release", "2026-Q2", "Polish, tutorial, controller support"]),
            ],
            "Milestones, revision 0.7",
        )
    } else {
        table(
            vec![col("Milestone", 0.3, false), col("Target", 0.2, false), col("Scope", 0.5, false)],
            vec![
                row(&["v0.1 Prototype", "2024-12", "Flight model and one station"]),
                row(&["v0.2 Vertical slice", "2025-01", "Three stations and trade"]),
                row(&["v0.3 Playtest", "2025-02", "Ship classes and first fittings"]),
                row(&["v0.4 Design draft", "2025-02", "This document"]),
                row(&["v0.5 Alpha", "2025-05", "Full economy, eight commodities"]),
            ],
            "Milestones, first draft",
        )
    });

    Doc {
        title: "Orbital \u{2014} game design document".into(),
        subtitle: "A small space-trading game about orbits, cargo and bad decisions".into(),
        author: if v2 { "Wen and Ilse".into() } else { "Wen".into() },
        date: if v2 { "2025-11-03".into() } else { "2025-02-20".into() },
        meta: vec![
            ("Version".into(), if v2 { "0.7" } else { "0.4" }.into()),
            ("Status".into(), if v2 { "Living document" } else { "Draft for the team" }.into()),
        ],
        cover: Some(scenes::title(version)),
        blocks: b,
    }
}

fn economy_v1(b: &mut Vec<Block>) {
    b.push(para("Eight commodities move between the stations. Each station posts a base price per tonne for every one of them, and the first draft holds those prices fixed. A station buys below its sell price, so a round trip with the same cargo always loses money, which keeps the player moving."));
    b.push(table(
        vec![col("Commodity", 0.28, false), col("Kestrel Ring", 0.24, true), col("Halden Depot", 0.24, true), col("Outpost Vire", 0.24, true)],
        vec![
            row(&["Fuel cells", "120", "110", "150"]),
            row(&["Water ice", "40", "35", "60"]),
            row(&["Iron ore", "75", "90", "65"]),
            row(&["Alloy plate", "260", "240", "300"]),
            row(&["Medkits", "180", "210", "190"]),
            row(&["Circuitry", "340", "320", "390"]),
            row(&["Hydroponics", "150", "130", "175"]),
            row(&["Reactor parts", "520", "560", "480"]),
        ],
        "Base prices in credits per tonne, first draft",
    ));
    b.push(para("The table is a starting point and nothing more. The playtest will tell us which goods the player actually carries, and the economy chapter of the next draft will rebuild the prices from supply and demand instead of typing them in."));
}

fn economy_v2(b: &mut Vec<Block>) {
    b.push(para("Prices now follow stock. Every station keeps a count of each commodity it holds, and its price moves with that count: a station short of iron ore pays more for it, and a station with a full store sells cheaper. Stock drifts back towards a station's normal level over time, so a market recovers on its own unless the player keeps feeding it."));
    b.push(Block::Diagram(economy_diagram()));
    b.push(para("The loop has three parts, and each one can be tuned on its own. Supply is what the stations hold and what the player brings. Price is what the station quotes. Demand is what the station's population and industry want, and it falls as the price rises, so a high price is a signal to sell and not a permanent state."));
    b.push(table(
        vec![col("Commodity", 0.3, false), col("Elasticity", 0.18, true), col("Restock (days)", 0.22, true), col("Shock cap", 0.3, true)],
        vec![
            row(&["Fuel cells", "0.4", "2", "35%"]),
            row(&["Water ice", "0.6", "4", "40%"]),
            row(&["Iron ore", "0.8", "5", "45%"]),
            row(&["Alloy plate", "1.1", "6", "50%"]),
            row(&["Medkits", "1.4", "3", "55%"]),
            row(&["Circuitry", "1.2", "7", "50%"]),
            row(&["Hydroponics", "0.9", "4", "40%"]),
            row(&["Reactor parts", "0.5", "10", "30%"]),
        ],
        "Elasticity and restock per commodity, revision 0.7",
    ));
    b.push(Block::Callout("Price shocks: a station that loses its supply to a raid recovers at most the shock cap of the gap per in-game day. A shock is a route change for the player, not a bug in the market.".into()));
    b.push(para("Elasticity says how far demand moves for a change in price. Goods with low elasticity, such as reactor parts, are bought whatever they cost, which is why they are the high-stakes cargo of the late game."));
}

fn loop_diagram() -> Diagram {
    let (w, y, h) = (82.0, 40.0, 44.0);
    let xs = [4.0, 130.0, 256.0, 382.0];
    let names = ["Fly", "Trade", "Upgrade", "Explore"];
    let fills = [TEAL, GOLD, VIOLET, RED];
    let mut shapes = Vec::new();
    for ((x, name), fill) in xs.iter().zip(names).zip(fills) {
        shapes.push(Shape::Box { x: *x, y, w, h, fill, label: name.into() });
    }
    for pair in xs.windows(2) {
        let mid = y + h / 2.0;
        shapes.push(Shape::Arrow { from: (pair[0] + w + 4.0, mid), to: (pair[1] - 4.0, mid), colour: INK });
    }
    // The loop closes underneath: out of Explore, back along the foot into Fly.
    shapes.push(Shape::Line { from: (423.0, y + h), to: (423.0, 104.0), colour: MUTED, dashed: false });
    shapes.push(Shape::Line { from: (423.0, 104.0), to: (45.0, 104.0), colour: MUTED, dashed: false });
    shapes.push(Shape::Arrow { from: (45.0, 104.0), to: (45.0, y + h + 2.0), colour: MUTED });
    Diagram { height: 120.0, caption: "The core loop: each step pays for the next".into(), shapes }
}

fn economy_diagram() -> Diagram {
    let (w, h) = (110.0, 36.0);
    let shapes = vec![
        Shape::Box { x: 178.0, y: 8.0, w, h, fill: TEAL, label: "Supply".into() },
        Shape::Box { x: 300.0, y: 110.0, w, h, fill: GOLD, label: "Price".into() },
        Shape::Box { x: 56.0, y: 110.0, w, h, fill: VIOLET, label: "Demand".into() },
        Shape::Arrow { from: (262.0, 44.0), to: (330.0, 110.0), colour: INK },
        Shape::Arrow { from: (300.0, 128.0), to: (170.0, 128.0), colour: INK },
        Shape::Arrow { from: (111.0, 108.0), to: (196.0, 44.0), colour: INK },
        Shape::Label { x: 318.0, y: 72.0, text: "stock is sold".into(), size: 8.0, colour: MUTED, bold: false },
        Shape::Label { x: 176.0, y: 158.0, text: "high price lowers demand".into(), size: 8.0, colour: MUTED, bold: false },
        Shape::Label { x: 52.0, y: 72.0, text: "demand pulls stock".into(), size: 8.0, colour: MUTED, bold: false },
    ];
    Diagram { height: 160.0, caption: "The economy's feedback loop, revision 0.7".into(), shapes }
}

fn contract_diagram() -> Diagram {
    let main = [(4.0, "Offered", VIOLET), (128.0, "Accepted", VIOLET), (252.0, "Loaded", VIOLET)];
    let mut shapes: Vec<Shape> = main.iter().map(|(x, label, fill)| Shape::Box { x: *x, y: 52.0, w: 88.0, h: 36.0, fill: *fill, label: (*label).into() }).collect();
    shapes.push(Shape::Box { x: 376.0, y: 14.0, w: 88.0, h: 30.0, fill: TEAL, label: "Delivered".into() });
    shapes.push(Shape::Box { x: 376.0, y: 92.0, w: 88.0, h: 30.0, fill: RED, label: "Failed".into() });
    shapes.push(Shape::Arrow { from: (94.0, 70.0), to: (124.0, 70.0), colour: INK });
    shapes.push(Shape::Arrow { from: (218.0, 70.0), to: (248.0, 70.0), colour: INK });
    shapes.push(Shape::Arrow { from: (342.0, 66.0), to: (373.0, 29.0), colour: INK });
    shapes.push(Shape::Arrow { from: (342.0, 74.0), to: (373.0, 107.0), colour: INK });
    Diagram { height: 130.0, caption: "The contract lifecycle: a contract ends delivered or failed".into(), shapes }
}

fn palette_diagram() -> Diagram {
    let swatches = [(GOLD, "Gold", "prices"), (TEAL, "Teal", "trade"), (VIOLET, "Violet", "contracts"), (RED, "Red", "danger"), (NAVY, "Navy", "space")];
    let mut shapes = Vec::new();
    for (i, (colour, name, use_)) in swatches.into_iter().enumerate() {
        let cx = 50.0 + i as f32 * 90.0;
        shapes.push(Shape::Disc { cx, cy: 30.0, r: 18.0, colour });
        shapes.push(Shape::Label { x: cx - 22.0, y: 62.0, text: name.into(), size: 9.0, colour: INK, bold: true });
        shapes.push(Shape::Label { x: cx - 22.0, y: 76.0, text: use_.into(), size: 8.0, colour: MUTED, bold: false });
    }
    Diagram { height: 96.0, caption: "The lane colours, and what each one means on screen".into(), shapes }
}

fn para(s: &str) -> Block {
    Block::Para(s.into())
}

fn bullets(items: &[&str]) -> Block {
    Block::Bullets(items.iter().map(|s| s.to_string()).collect())
}

fn col(title: &str, width: f32, right: bool) -> Column {
    Column { title: title.into(), width, right }
}

fn row(cells: &[&str]) -> Vec<String> {
    cells.iter().map(|c| c.to_string()).collect()
}

fn table(columns: Vec<Column>, rows: Vec<Vec<String>>, caption: &str) -> Block {
    Block::Table(Table { columns, rows, caption: caption.into() })
}

fn title_case(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h1s(v: u16) -> Vec<String> {
        design_doc(v).blocks.into_iter().filter_map(|b| if let Block::H1(t) = b { Some(t) } else { None }).collect()
    }
    fn pages(pdf: &[u8]) -> usize {
        String::from_utf8_lossy(pdf).split("/Count ").nth(1).unwrap().split(' ').next().unwrap().parse().unwrap()
    }

    #[test]
    fn both_revisions_render_at_their_lengths() {
        let (a, b) = (pdf(1), pdf(2));
        assert!(pages(&a) >= 6, "v1: {} pages", pages(&a));
        assert!(pages(&b) >= 8, "v2: {} pages", pages(&b));
        assert!(a.len() < 250_000 && b.len() < 250_000, "{} / {}", a.len(), b.len());
        assert_eq!(pdf(2), pdf(2));
    }

    #[test]
    fn the_revision_keeps_the_skeleton_and_changes_the_substance() {
        let (a, b) = (h1s(1), h1s(2));
        assert_eq!(a, ["Overview", "Core loop", "Orbital flight", "Ships", "Economy", "Stations", "Art direction", "Roadmap"]);
        assert!(b.contains(&"Contracts".to_string()) && !a.contains(&"Contracts".to_string()));
        assert!(a.iter().filter(|h| b.contains(h)).count() >= 7);
        let tables = |v| design_doc(v).blocks.into_iter().filter(|b| matches!(b, Block::Table(_))).count();
        assert!(tables(1) >= 4 && tables(2) >= 5);
        let diagrams = |v| design_doc(v).blocks.into_iter().filter(|b| matches!(b, Block::Diagram(_))).count();
        assert!(diagrams(1) >= 3 && diagrams(2) >= 4);
    }
}
