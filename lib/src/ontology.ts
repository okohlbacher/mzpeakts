
"https://www.ebi.ac.uk/ols4/api/ontologies/ms/terms/http%253A%252F%252Fpurl.obolibrary.org%252Fobo%252FMS_1000044";

export class Ols4OntologyResolver {
  base: string = "https://www.ebi.ac.uk/ols4/api/ontologies";
  ontology: string = "ms";
  iriPrefix: string = "http%253A%252F%252Fpurl.obolibrary.org%252Fobo%252F";
  cache: Map<string, any>

  constructor(
    base: string = "https://www.ebi.ac.uk/ols4/api/ontologies",
    ontology: string = "ms",
    iriPrefix: string = "http%253A%252F%252Fpurl.obolibrary.org%252Fobo%252F",
  ) {
    this.base = base;
    this.ontology = ontology;
    this.iriPrefix = iriPrefix;
    this.cache = new Map();
  }

  makeUrl(iri: string) {
    return `${this.base}/${this.ontology}/terms/${this.iriPrefix}${iri.replace(':', '_')}`;
  }

  async get(iri: string) {
    if (this.cache.has(iri)) return this.cache.get(iri)
    const record = await (await fetch(this.makeUrl(iri))).json()
    this.cache.set(iri, record);
    return record
  }
}

export const MS = new Ols4OntologyResolver();
export const UO = new Ols4OntologyResolver();
UO.ontology = 'uo'