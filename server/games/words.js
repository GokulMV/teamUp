// Word bank for Pictionary. Kept simple and family friendly.
const WORDS = `
apple banana pizza burger donut cake cookie sandwich taco popcorn carrot pineapple watermelon cheese egg
cat dog fish bird horse cow pig sheep lion tiger elephant giraffe monkey penguin shark whale octopus snake frog turtle
rabbit bear owl bee butterfly spider snail crab dolphin kangaroo zebra camel duck chicken dinosaur unicorn dragon
house castle bridge tower lighthouse tent igloo pyramid windmill skyscraper church barn school hospital
car bus train airplane helicopter rocket bicycle boat submarine tractor scooter skateboard truck ambulance sailboat
sun moon star cloud rainbow lightning snowman volcano mountain island beach river waterfall tornado desert forest
tree flower cactus mushroom leaf palm rose sunflower
guitar piano drum trumpet violin microphone headphones
ball kite balloon robot puzzle yoyo dice chess teddy
phone computer camera television lamp clock key lock umbrella glasses hat crown shoe sock shirt backpack
scissors hammer ladder bucket candle broom toothbrush pencil book envelope magnet battery lightbulb
football basketball tennis bowling golf surfing skiing swimming boxing archery fishing
king queen pirate ninja wizard ghost zombie vampire mermaid astronaut cowboy clown chef doctor firefighter
heart smile eye nose ear hand foot tooth brain skeleton
treasure map compass anchor parachute telescope trophy medal flag fireworks campfire
spaghetti sushi hotdog pancake popsicle lollipop cupcake pretzel
snowflake tornado earthquake shadow bubble rain wind
`.split(/\s+/).filter(Boolean);

const PHRASES = [
  'ice cream', 'hot air balloon', 'roller coaster', 'traffic light', 'paper plane', 'shooting star',
  'fire truck', 'polar bear', 'spider web', 'swimming pool', 'birthday cake', 'treasure chest',
  'haunted house', 'tooth fairy', 'flying saucer', 'magic wand', 'french fries', 'pizza delivery',
  'sand castle', 'black hole', 'solar system', 'video game', 'tug of war', 'hide and seek',
];

const ALL = [...new Set([...WORDS, ...PHRASES])];

function pickWords(count, exclude = new Set()) {
  const pool = ALL.filter((w) => !exclude.has(w));
  const out = [];
  while (out.length < count && pool.length) {
    const i = Math.floor(Math.random() * pool.length);
    out.push(pool.splice(i, 1)[0]);
  }
  return out;
}

module.exports = { pickWords, ALL_WORDS: ALL };
