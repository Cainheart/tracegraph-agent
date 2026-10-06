import { ConfigurableModelAdapter, type ModelProviderConfig, type ModelAdapter, type ConfigurableModelAdapterOptions } from "@tracegraph/core";
import type { ModelCapabilities } from "@tracegraph/contracts";

/** The composition owns rotation; immutable request snapshots keep their credential until settlement. */
export class LeasedModelAdapter extends ConfigurableModelAdapter {
  #reference: string | undefined;
  #configuration:ModelProviderConfig|undefined;
  readonly #options:ConfigurableModelAdapterOptions;
  constructor(options:ConfigurableModelAdapterOptions={}){super(options);this.#options=options;}
  override clearConfiguration():void {super.clearConfiguration();this.#configuration=undefined;this.#reference=undefined;}
  forRun():ModelAdapter & ConfigurableModelAdapter {
    return this.forConfiguration(this.#configuration);
  }
  forConfiguration(configuration:ModelProviderConfig|undefined,capabilities?:ModelCapabilities):ModelAdapter & ConfigurableModelAdapter {
    const capturedConfiguration=configuration===undefined?undefined:Object.freeze({...configuration});
    const capturedCapabilities=Object.freeze({...capabilities??this.#options.capabilities??{image_input:false}});
    const snapshot=new ConfigurableModelAdapter({...this.#options,capabilities:capturedCapabilities});
    if(capturedConfiguration)snapshot.configure(capturedConfiguration);
    const reference=capturedConfiguration?.credentialRef;
    if(reference)this.#leases.set(reference,(this.#leases.get(reference)??0)+1);
    let released=false;
    return Object.assign(snapshot,{
      // Children inherit the admitted model, but must never share the parent's
      // idempotent release function. Each fork owns one reference to the same
      // frozen config/capabilities, independent of later settings changes.
      forRun:()=>{if(released)throw new Error("The admitted model lease has already settled");return this.forConfiguration(capturedConfiguration,capturedCapabilities);},
      releaseRun:()=>{if(released)return;released=true;if(reference){const count=(this.#leases.get(reference)??1)-1;if(count===0)this.#leases.delete(reference);else this.#leases.set(reference,count);this.#settle(reference);}},
    });
  }
  readonly #leases = new Map<string, number>();
  readonly #retired = new Map<string, () => Promise<void>>();
  override configure(value: ModelProviderConfig): void {
    super.configure(value);
    this.#reference = value.credentialRef;
    this.#configuration={...value};
  }
  retireCredential(reference: string, cleanup: () => Promise<unknown>): void {
    this.#retired.set(reference, async () => { await cleanup(); });
    this.#settle(reference);
  }
  async #request<T>(operation: () => Promise<T>): Promise<T> {
    const reference = this.#reference;
    if (reference !== undefined) this.#leases.set(reference, (this.#leases.get(reference) ?? 0) + 1);
    try { return await operation(); }
    finally {
      if (reference !== undefined) {
        const count = (this.#leases.get(reference) ?? 1) - 1;
        if (count === 0) this.#leases.delete(reference); else this.#leases.set(reference, count);
        this.#settle(reference);
      }
    }
  }
  #settle(reference: string): void {
    if (this.#leases.has(reference)) return;
    const cleanup = this.#retired.get(reference);
    if (!cleanup) return;
    this.#retired.delete(reference);
    void cleanup().catch(() => {
      process.stderr.write("Superseded credential cleanup failed; no credential value was logged.\n");
    });
  }
  override decide(...args: Parameters<ConfigurableModelAdapter["decide"]>): ReturnType<ConfigurableModelAdapter["decide"]> {
    return this.#request(() => super.decide(...args));
  }
  override testConnection(...args: Parameters<ConfigurableModelAdapter["testConnection"]>): ReturnType<ConfigurableModelAdapter["testConnection"]> {
    return this.#request(() => super.testConnection(...args));
  }
  override testCapability(...args: Parameters<ConfigurableModelAdapter["testCapability"]>): ReturnType<ConfigurableModelAdapter["testCapability"]> {
    return this.#request(() => super.testCapability(...args));
  }
  override summarizeContext(...args: Parameters<ConfigurableModelAdapter["summarizeContext"]>): ReturnType<ConfigurableModelAdapter["summarizeContext"]> {
    return this.#request(() => super.summarizeContext(...args));
  }
  override extractMemoryEpisode(...args: Parameters<ConfigurableModelAdapter["extractMemoryEpisode"]>): ReturnType<ConfigurableModelAdapter["extractMemoryEpisode"]> {
    return this.#request(() => super.extractMemoryEpisode(...args));
  }
  override extractExperienceCase(...args: Parameters<ConfigurableModelAdapter["extractExperienceCase"]>): ReturnType<ConfigurableModelAdapter["extractExperienceCase"]> {
    return this.#request(() => super.extractExperienceCase(...args));
  }
}
