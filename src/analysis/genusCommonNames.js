/**
 * Plain-English common names for the plant genera that appear in the
 * keystone-genus screen (src/analysis/keystoneScreen.js). This is a static
 * label lookup, not a data source — "Quercus" reads as "oak" to nobody who
 * hasn't already memorised Latin, and the flora screen otherwise shows genus
 * names only.
 *
 * Genus, not species: several genera cover more than one common name in
 * casual use (Rosa is both "rose" and "rambling rose"); one representative
 * name is picked per genus rather than every variant.
 */
const GENUS_COMMON_NAMES = {
  Abies: 'fir',
  Acer: 'maple',
  Alnus: 'alder',
  Amelanchier: 'serviceberry',
  Asclepias: 'milkweed',
  Astragalus: 'milkvetch',
  Baccharis: 'groundseltree',
  Baileya: 'desert marigold',
  Betula: 'birch',
  Bidens: 'beggarticks',
  Bouteloua: 'grama grass',
  Carya: 'hickory',
  Castanea: 'chestnut',
  Cercis: 'redbud',
  Chrysopsis: 'goldenaster',
  Chrysothamnus: 'rabbitbrush',
  Cirsium: 'thistle',
  Coreopsis: 'tickseed',
  Cornus: 'dogwood',
  Corylus: 'hazelnut',
  Crataegus: 'hawthorn',
  Dalea: 'prairie clover',
  Ericameria: 'rabbitbrush',
  Erigeron: 'fleabane',
  Fraxinus: 'ash',
  Gaillardia: 'blanketflower',
  Gonolobus: 'milkvine',
  Grindelia: 'gumweed',
  Gutierrezia: 'snakeweed',
  Helenium: 'sneezeweed',
  Helianthus: 'sunflower',
  Heliomeris: 'goldeneye',
  Heliopsis: 'oxeye',
  Heterotheca: 'goldenaster',
  Ilex: 'holly',
  Isocoma: 'jimmyweed',
  Juglans: 'walnut',
  Larix: 'larch',
  Machaeranthera: 'tansyaster',
  Malus: 'crabapple',
  Malvaviscus: "turk's cap",
  Matelea: 'milkvine',
  Oenothera: 'evening primrose',
  Packera: 'ragwort',
  Passiflora: 'passionflower',
  Picea: 'spruce',
  Pinus: 'pine',
  Populus: 'cottonwood',
  Prunus: 'plum',
  Pseudotsuga: 'Douglas fir',
  Quercus: 'oak',
  Ratibida: 'prairie coneflower',
  Rosa: 'rose',
  Rubus: 'blackberry',
  Rudbeckia: 'black-eyed Susan',
  Salix: 'willow',
  Schizachyrium: 'bluestem',
  Senecio: 'ragwort',
  Solidago: 'goldenrod',
  Sorghastrum: 'indiangrass',
  Symphyotrichum: 'aster',
  Tilia: 'basswood',
  Tsuga: 'hemlock',
  Ulmus: 'elm',
  Vaccinium: 'blueberry',
  Verbesina: 'crownbeard',
  Vernonia: 'ironweed',
  Vitis: 'grape',
};

export function genusCommonName(genus) {
  return GENUS_COMMON_NAMES[genus] || null;
}
