# One-off conversion of the legacy Floreant demo menu (legacy/floreant-menu-export.json) into
# data/menu.json. Usage: python data/tools/build_menu_from_legacy.py legacy/floreant-menu-export.json data/menu.json
import json, re, sys
src = json.load(open(sys.argv[1]))['items']

CATEGORIES = [
    ("brunch", "Brunch"), ("starters", "Starters"), ("pub_classics", "Pub Classics"),
    ("sandwiches", "Sandwiches"), ("sides", "Sides"), ("children", "Children"),
    ("puddings", "Puddings"), ("soft_and_hot_drinks", "Soft & Hot Drinks"),
    ("beer_and_cider", "Beer & Cider"), ("wine", "Wine"),
]
CAT_MAP = {"BRUNCH": "brunch", "STARTERS": "starters", "PUB CLASSICS": "pub_classics",
           "SANDWICHES": "sandwiches", "SIDES": "sides", "CHILDREN": "children",
           "PUDDINGS": "puddings", "DRINKS": "soft_and_hot_drinks"}

def slug(name):
    s = name.lower().replace("&", "and").replace("'", "").replace("é", "e")
    return re.sub(r"[^a-z0-9]+", "_", s).strip("_")

SIZE_PATTERNS = [(r" Half Pint$", "half"), (r" Two Pints$", "two_pints"), (r" Pint$", "pint"),
                 (r" 175ml$", "175ml"), (r" 250ml$", "250ml"), (r" Bottle$", "bottle")]
SIZE_NAMES = {"half": "half pint", "pint": "pint", "two_pints": "two pints",
              "175ml": "175ml glass", "250ml": "250ml glass", "bottle": "bottle"}
SIZE_ORDER = ["half", "pint", "two_pints", "175ml", "250ml", "bottle"]

items, sized = {}, {}
for it in sorted(src, key=lambda i: i["id"]):  # later ids overwrite duplicates (newer entry wins)
    name, price, cat = it["name"], it["price"], it.get("categoryName")
    size = next((sid for pat, sid in SIZE_PATTERNS if re.search(pat, name)), None)
    if size:
        base = re.sub(next(p for p, s in SIZE_PATTERNS if s == size), "", name)
        sized.setdefault(base, {})[size] = price
        continue
    items[slug(name)] = {"name": name, "category": CAT_MAP[cat], "price": price}

# Fill gaps so every draught has half / pint / two pints and every wine 175ml / 250ml / bottle
# (mock prices, consistent with the rest of the list).
FILL = {"Copper House Lager": {"pint": 5.5, "two_pints": 10.5},
        "House Red Wine": {"bottle": 23.95}, "House White Wine": {"250ml": 8.5},
        "Cask Pale Ale": {"half": 3.0, "two_pints": 10.5}, "Session IPA": {"half": 3.25, "two_pints": 11.5}}
for base, sizes in sized.items():
    sizes.update({k: v for k, v in FILL.get(base, {}).items() if k not in sizes})
    is_wine = any(k in sizes for k in ("175ml", "250ml", "bottle"))
    default = "175ml" if is_wine else "pint"
    items[slug(base)] = {
        "name": base, "category": "wine" if is_wine else "beer_and_cider",
        "default_size": default,
        "sizes": [{"id": s, "name": SIZE_NAMES[s], "price": sizes[s]} for s in SIZE_ORDER if s in sizes],
    }

ALIASES = {
    "fish_and_chips": ["fish n chips", "fish and chip"], "cola": ["coke", "coca cola"],
    "beef_burger": ["burger", "cheeseburger"], "skin_on_chips": ["chips", "fries"],
    "full_english_breakfast": ["full english", "fry up"], "english_breakfast_tea": ["tea", "cup of tea"],
    "americano": ["coffee", "black coffee"], "bangers_and_mash": ["bangers", "sausage and mash"],
    "scampi_and_chips": ["scampi"], "steak_and_ale_pie": ["steak pie"], "beer_battered_cod": ["cod"],
    "mini_fish_fingers_and_chips": ["fish fingers"], "apple_cider": ["cider"], "session_ipa": ["ipa"],
    "london_porter": ["porter"], "house_red_wine": ["red wine", "house red", "glass of red"],
    "house_white_wine": ["white wine", "house white", "glass of white"], "homemade_lemonade": ["lemonade"],
    "chocolate_milkshake": ["milkshake"], "copper_house_lager": ["lager"], "yorkshire_bitter": ["bitter"],
    "copper_house_pale_ale": ["pale ale"], "flat_white": ["flattie"], "macaroni_cheese": ["mac and cheese"],
    "sticky_toffee_pudding": ["sticky toffee", "stp"], "apple_crumble_and_custard": ["apple crumble", "crumble"],
}
MODIFIER_GROUPS = [
    {"id": "milk", "name": "Milk", "max": 1, "default": "whole milk", "options": [
        {"name": "whole milk", "price": 0}, {"name": "semi skimmed milk", "price": 0},
        {"name": "oat milk", "price": 0.4}, {"name": "soy milk", "price": 0.4}, {"name": "no milk", "price": 0}]},
    {"id": "eggs", "name": "Eggs", "max": 1, "default": "fried eggs", "options": [
        {"name": "fried eggs", "price": 0}, {"name": "poached eggs", "price": 0}, {"name": "scrambled eggs", "price": 0}]},
    {"id": "peas", "name": "Peas", "max": 1, "default": "mushy peas", "options": [
        {"name": "mushy peas", "price": 0}, {"name": "garden peas", "price": 0}, {"name": "no peas", "price": 0}]},
    {"id": "sauce", "name": "Sauce", "max": 2, "default": None, "options": [
        {"name": "ketchup", "price": 0}, {"name": "brown sauce", "price": 0}, {"name": "mayonnaise", "price": 0},
        {"name": "tartare sauce", "price": 0}, {"name": "curry sauce", "price": 1.0}, {"name": "gravy", "price": 1.0}]},
    {"id": "burger_extras", "name": "Extras", "max": 3, "default": None, "options": [
        {"name": "extra cheese", "price": 1.0}, {"name": "bacon", "price": 1.5}, {"name": "fried egg", "price": 1.0}]},
    {"id": "burger_remove", "name": "Leave out", "max": 4, "default": None, "options": [
        {"name": "no onions", "price": 0}, {"name": "no tomato", "price": 0},
        {"name": "no lettuce", "price": 0}, {"name": "no pickles", "price": 0}]},
]
GROUPS_FOR = {
    "milk": ["flat_white", "americano", "english_breakfast_tea", "decaf_tea"],
    "eggs": ["full_english_breakfast", "double_up_full_english", "vegetarian_full_english", "sausage_and_egg_bap", "sunday_brunch_plate"],
    "peas": ["fish_and_chips", "scampi_and_chips", "beer_battered_cod", "kids_fish_and_chips"],
    "sauce": ["fish_and_chips", "scampi_and_chips", "beer_battered_cod", "skin_on_chips", "cheesy_chips",
              "battered_sausage_and_chips", "beef_burger", "chicken_burger", "mushroom_and_halloumi_burger",
              "kids_fish_and_chips", "mini_fish_fingers_and_chips", "sausage_and_egg_bap"],
    "burger_extras": ["beef_burger", "chicken_burger", "mushroom_and_halloumi_burger"],
    "burger_remove": ["beef_burger", "chicken_burger", "mushroom_and_halloumi_burger"],
}
BAR = {"soft_and_hot_drinks", "beer_and_cider", "wine"}
cat_order = [c for c, _ in CATEGORIES]
out_items = []
for mid, it in sorted(items.items(), key=lambda kv: (cat_order.index(kv[1]["category"]), kv[1]["name"])):
    entry = {"id": mid, "name": it["name"], "category": it["category"],
             "station": "bar" if it["category"] in BAR else "kitchen"}
    if "sizes" in it:
        entry["default_size"] = it["default_size"]
        entry["sizes"] = it["sizes"]
    else:
        entry["price"] = it["price"]
    entry["aliases"] = ALIASES.get(mid, [])
    entry["modifier_groups"] = [g for g, ids in GROUPS_FOR.items() if mid in ids]
    out_items.append(entry)
missing = {a for a in ALIASES if a not in items} | {i for ids in GROUPS_FOR.values() for i in ids if i not in items}
assert not missing, missing
menu = {"version": 1, "currency": "GBP", "venue": "The Crown & Copper (mock)",
        "categories": [{"id": c, "name": n} for c, n in CATEGORIES],
        "modifier_groups": MODIFIER_GROUPS, "items": out_items}
json.dump(menu, open(sys.argv[2], "w"), indent=2, ensure_ascii=False)
print(len(out_items), "items;", sum("sizes" in i for i in out_items), "with sizes")
