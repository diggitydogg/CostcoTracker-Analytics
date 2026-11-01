/**
 * Deterministic description rules. Pure data, separate from the matcher and
 * from all analytics, so rules can be tuned without touching calculations.
 *
 * Matching (see engine.ts): a description is upper-cased and split into
 * alphanumeric tokens. A rule phrase is a sequence of tokens that must appear
 * contiguously; a token ending in "*" matches any token with that prefix.
 * A phrase starting with "^" must start the description and one ending in
 * "$" must end it, so "^KS BATH$" matches only the bare (truncated) receipt
 * text "KS BATH", never "KS BATH TOWEL".
 * Rules are evaluated top to bottom and the FIRST match wins, so specific
 * phrases ("PEANUT BUTTER", "HOT DOG", "PAPER TOWEL*") are listed before the
 * generic words they contain ("BUTTER", "DOG", "TOWEL*").
 *
 * Adding rules: prefer brand names and multi-word product phrases over single
 * generic words, put a rule above any broader rule that would capture it, and
 * add positive AND negative cases to categories.test.ts. An ambiguous product
 * is better left Uncategorized (the owner can override it) than misfiled.
 */
import type { CategoryId, SubcategoryId } from './taxonomy'

export type CategoryRule = {
  id: string
  categoryId: CategoryId
  subcategoryId?: SubcategoryId
  phrases: string[]
}

const g = (id: string, subcategoryId: SubcategoryId, phrases: string[]): CategoryRule => ({
  id,
  categoryId: 'grocery',
  subcategoryId,
  phrases,
})

export const DEFAULT_RULES: CategoryRule[] = [
  // Specific phrases that would otherwise be captured by a broader rule below.
  g('specific-meat', 'meat-seafood', ['HOT DOG*', 'CORN DOG*']),
  g('specific-produce', 'produce', ['BELL PEPPER*', 'SWEET POTATO*', 'MINI PEPPER*']),
  g('specific-pantry', 'pantry', ['PEANUT BUTTER', 'ALMOND BUTTER', 'OLIVE OIL', 'AVOCADO OIL', 'COCONUT OIL', 'CHICKEN BROTH', 'BONE BROTH']),
  g('specific-snacks', 'snacks', ['MILK CHOCOLATE', 'DARK CHOCOLATE', 'BEEF JERKY', 'TRAIL MIX', 'FRUIT SNACK*', 'GRANOLA BAR*', 'PROTEIN BAR*', 'POPCORNERS']),
  // Water/faucet filters belong with household filters, not with faucets (home).
  { id: 'specific-household', categoryId: 'household', phrases: ['FAUCET FILTER*', 'WATER FILTER*'] },
  g('specific-beverages', 'beverages', ['OAT MILK', 'ALMOND MILK', 'COCONUT WATER', 'SPARKLING WATER', 'ORANGE JUICE', 'APPLE JUICE', 'ENERGY DRINK*', 'SPORTS DRINK*', 'K CUP*']),
  g('specific-frozen', 'frozen', ['ICE CREAM']),

  {
    id: 'alcohol',
    categoryId: 'alcohol',
    phrases: [
      'HARD SELTZER', 'WINE', 'WINES', 'BEER', 'VODKA', 'WHISKEY', 'WHISKY', 'BOURBON', 'TEQUILA', 'RUM', 'GIN',
      'CHAMPAGNE', 'PROSECCO', 'CABERNET', 'CHARDONNAY', 'PINOT', 'MERLOT', 'SAUVIGNON', 'RIESLING', 'IPA',
      'LAGER', 'SAKE', 'SCOTCH', 'BRANDY', 'COGNAC', 'LIQUEUR', 'MEZCAL', 'SPIKED',
    ],
  },
  {
    id: 'pet',
    categoryId: 'pet',
    phrases: ['DOG', 'DOGS', 'CAT', 'CATS', 'PUPPY', 'KITTEN', 'PET', 'PETS', 'KIBBLE', 'LITTER', 'KITTY', 'FELINE', 'CANINE'],
  },
  {
    id: 'automotive',
    categoryId: 'automotive',
    phrases: ['MOTOR OIL', 'TIRE', 'TIRES', 'WIPER*', 'WINDSHIELD', 'ANTIFREEZE', 'CAR WASH', 'CAR BATTERY', 'AUTOMOTIVE', 'JUMP STARTER'],
  },
  {
    id: 'paper-goods',
    categoryId: 'paper-goods',
    phrases: [
      'PAPER TOWEL*', 'PAPER TWL*', 'TOILET PAPER', 'BATH TISSUE', 'BATH TISS', 'FACIAL TISSUE*', 'TISSUE', 'TISSUES',
      'NAPKIN*', 'PAPER PLATE*', 'KLEENEX', 'BOUNTY', 'CHARMIN',
      // Kirkland bath tissue, truncated on the receipt to exactly "KS BATH".
      '^KS BATH$',
    ],
  },
  {
    id: 'cleaning',
    categoryId: 'cleaning',
    phrases: [
      'DISINFECTING WIPES', 'DISINFECT*', 'DETERGENT', 'LAUNDRY', 'DISHWASHER', 'DISH SOAP', 'CLEANER', 'CLEANING',
      'BLEACH', 'LYSOL', 'CLOROX', 'TIDE', 'CASCADE', 'SPONGE*', 'FABRIC SOFTENER', 'DRYER SHEETS', 'OXICLEAN', 'SCRUB*',
    ],
  },
  {
    id: 'personal-care',
    categoryId: 'personal-care',
    phrases: [
      'BABY WIPES', 'WIPES', 'SHAMPOO', 'CONDITIONER', 'BODY WASH', 'HAND SOAP', 'SOAP', 'TOOTHPASTE', 'TOOTHBRUSH*',
      'DEODORANT', 'RAZOR*', 'LOTION', 'SUNSCREEN', 'DIAPER*', 'MOUTHWASH', 'FLOSS', 'COTTON SWAB*', 'FACE WASH',
      'MOISTURIZER', 'COSMETIC*', 'MAKEUP',
    ],
  },
  {
    id: 'health',
    categoryId: 'health',
    phrases: [
      'VITAMIN*', 'MULTIVITAMIN*', 'SUPPLEMENT*', 'IBUPROFEN', 'ACETAMINOPHEN', 'ALLERGY', 'ANTACID', 'FISH OIL', 'OMEGA',
      'PROBIOTIC*', 'MELATONIN', 'BANDAGE*', 'FIRST AID', 'PAIN RELIEF', 'CONTACT LENS*', 'COLLAGEN', 'PROTEIN POWDER',
      'ZYRTEC', 'CLARITIN', 'ADVIL', 'TYLENOL', 'ALEVE', 'NASAL', 'COUGH', 'VITALPROTEIN*', 'VITAL PROTEIN*',
    ],
  },
  {
    id: 'electronics',
    categoryId: 'electronics',
    phrases: [
      'TV', 'TELEVISION', 'LAPTOP', 'IPAD', 'IPHONE', 'TABLET', 'HEADPHONE*', 'EARBUDS', 'AIRPODS', 'HDMI', 'USB',
      'CHARGER', 'CABLE', 'MONITOR', 'CAMERA', 'SPEAKER*', 'SSD', 'ROUTER', 'PRINTER', 'INK', 'KEYBOARD', 'SMARTWATCH',
      'APPLE WATCH', 'SOUNDBAR', 'NINTENDO', 'PLAYSTATION', 'XBOX', 'SD CARD', 'MEMORY CARD',
      'ANKER', 'MAGGO', 'MAGSAFE', 'CHARGING STATION*', 'CHARGING PAD*', 'WIRELESS CHARG*', 'POWER BANK*',
    ],
  },
  {
    id: 'clothing',
    categoryId: 'clothing',
    phrases: [
      'SHIRT*', 'TEE', 'TEES', 'PANT', 'PANTS', 'JEANS', 'SOCK*', 'JACKET', 'SHORTS', 'SWEATER', 'HOODIE', 'LEGGING*',
      'UNDERWEAR', 'BOXER*', 'BRA', 'BRAS', 'SHOE*', 'SNEAKER*', 'SLIPPER*', 'DRESS', 'POLO', 'FLEECE', 'VEST',
      'PAJAMA*', 'JOGGER*', 'GLOVES', 'COAT',
    ],
  },
  {
    id: 'seasonal',
    categoryId: 'seasonal',
    phrases: [
      'CHRISTMAS', 'XMAS', 'HALLOWEEN', 'HOLIDAY', 'ORNAMENT*', 'WREATH', 'GARLAND', 'EASTER', 'THANKSGIVING',
      'VALENTINE*', 'PATIO', 'POOL', 'COSTUME*', 'FIREPIT*', 'FIRE PIT*',
    ],
  },
  {
    id: 'home',
    categoryId: 'home',
    phrases: [
      'BATH TOWEL*', 'BATH SHEET*', 'TOWEL*', 'SHEET SET', 'SHEETS', 'PILLOW*', 'BLANKET*', 'COMFORTER', 'DUVET',
      'MATTRESS', 'LAMP', 'RUG', 'CHAIR', 'TABLE', 'COOKWARE', 'SKILLET', 'FRY PAN', 'KNIFE', 'KNIVES', 'CUTTING BOARD',
      'DESK', 'SHELF', 'SHELVING', 'VACUUM', 'CURTAIN*', 'FURNITURE', 'STORAGE BIN*', 'FOOD STORAGE', 'DINNERWARE',
      'MUG', 'MUGS', 'PLANTER*', 'GARDEN', 'MULCH', 'HOSE', 'FAUCET*', 'SHELVES', 'ZBEAM*', 'BISSELL*',
    ],
  },
  {
    id: 'household',
    categoryId: 'household',
    phrases: [
      'TRASH BAG*', 'GARBAGE BAG*', 'KITCHEN BAG*', 'ALUMINUM FOIL', 'FOIL', 'PLASTIC WRAP', 'ZIPLOC', 'STORAGE BAG*',
      'SANDWICH BAG*', 'FREEZER BAG*', 'BATTERIES', 'BATTERY', 'LIGHT BULB*', 'BULB*', 'AIR FILTER*', 'FILTER*',
      'PARCHMENT', 'CUPS', 'PLATES', 'UTENSIL*', 'STRAWS', 'LIGHTER*', 'CANDLE*',
    ],
  },

  // Grocery: frozen, snacks, beverages, bakery, pantry, dairy, meat, produce — in this order.
  g('frozen', 'frozen', ['FROZEN', 'FRZN', 'FRZ', 'GELATO', 'POTSTICKER*', 'DUMPLING*']),
  g('snacks', 'snacks', [
    'CHOCOLATE', 'CHOCOLATES', 'CHIPS', 'CHIP', 'CRACKER*', 'COOKIE*', 'CANDY', 'GUMMY', 'GUMMIES', 'PRETZEL*',
    'POPCORN', 'MIXED NUTS', 'NUTS', 'ALMONDS', 'CASHEW*', 'PISTACHIO*', 'PEANUTS', 'JERKY', 'SNACK*', 'SEAWEED',
    'RICE CAKE*', 'BARS',
  ]),
  g('beverages', 'beverages', [
    'WATER', 'SODA', 'COLA', 'COKE', 'PEPSI', 'LACROIX', 'JUICE', 'COFFEE', 'KCUP*', 'ESPRESSO', 'TEA', 'KOMBUCHA',
    'GATORADE', 'LEMONADE', 'DRINK*', 'BEVERAGE*', 'SPINDRIFT',
  ]),
  g('bakery', 'bakery', [
    'BREAD', 'BAGEL*', 'MUFFIN*', 'CROISSANT*', 'TORTILLA*', 'CAKE', 'CUPCAKE*', 'PIE', 'ROLLS', 'BUNS', 'DONUT*',
    'DANISH', 'BAGUETTE', 'SOURDOUGH', 'CHEESECAKE',
  ]),
  g('pantry', 'pantry', [
    'OIL', 'RICE', 'PASTA', 'SPAGHETTI', 'FLOUR', 'SUGAR', 'SAUCE', 'SALSA', 'KETCHUP', 'MUSTARD', 'MAYO*', 'DRESSING',
    'VINEGAR', 'CEREAL', 'OATS', 'OATMEAL', 'GRANOLA', 'SPICE*', 'SEASONING', 'SALT', 'PEPPER', 'HONEY', 'SYRUP',
    'MAPLE', 'BEANS', 'SOUP', 'BROTH', 'CANNED', 'ALBACORE', 'QUINOA', 'NOODLE*', 'RAMEN', 'JAM', 'JELLY', 'NUTELLA',
    'VANILLA', 'PANCAKE*',
  ]),
  g('dairy', 'dairy-eggs', [
    'MILK', 'CHEESE', 'BUTTER', 'EGG', 'EGGS', 'YOGURT', 'CREAM', 'COTTAGE', 'PARMESAN', 'MOZZARELLA', 'CHEDDAR',
    'BRIE', 'CREAMER', 'KEFIR', 'GHEE',
  ]),
  g('meat-seafood', 'meat-seafood', [
    'CHICKEN', 'BEEF', 'STEAK*', 'PORK', 'BACON', 'SALMON', 'SHRIMP', 'TURKEY', 'HAM', 'SAUSAGE*', 'RIBEYE',
    'BRISKET', 'LAMB', 'COD', 'TILAPIA', 'CRAB', 'LOBSTER', 'SCALLOP*', 'TENDERLOIN', 'ROAST', 'RIBS', 'WINGS',
    'THIGH*', 'BREAST*', 'MEATBALL*', 'SIRLOIN', 'TRI TIP', 'FISH', 'SEAFOOD', 'TUNA', 'GROUND BEEF', 'GROUND TURKEY',
  ]),
  g('produce', 'produce', [
    'BANANA*', 'APPLE', 'APPLES', 'AVOCADO*', 'BERRIES', 'STRAWBERR*', 'BLUEBERR*', 'RASPBERR*', 'BLACKBERR*',
    'GRAPE*', 'LETTUCE', 'ROMAINE', 'SPINACH', 'SALAD', 'TOMATO*', 'ONION*', 'POTATO*', 'CARROT*', 'LEMON*', 'LIME*',
    'ORANGE*', 'MANDARIN*', 'CLEMENTINE*', 'MANGO*', 'PINEAPPLE*', 'BROCCOLI', 'CUCUMBER*', 'ASPARAGUS', 'KALE',
    'CELERY', 'GARLIC', 'MUSHROOM*', 'PEAR', 'PEARS', 'PEACH*', 'PLUM*', 'CHERR*', 'WATERMELON', 'MELON*',
    'CANTALOUPE', 'KIWI*', 'ZUCCHINI', 'SQUASH', 'CILANTRO', 'HERBS', 'VEGGIE*', 'VEGETABLE*', 'FRUIT', 'PRODUCE',
  ]),
  // Prepared/deli foods that are clearly groceries but fit no subcategory. Last, so any
  // more specific rule above (meat, produce, pantry…) wins first.
  { id: 'grocery-prepared', categoryId: 'grocery', phrases: ['STREET TACO*', 'MEDITERR*'] },
]
