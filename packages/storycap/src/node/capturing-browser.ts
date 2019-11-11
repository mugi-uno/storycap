import { EventEmitter } from 'events';
import path from 'path';
import { Viewport } from 'puppeteer';
import { Story, StorybookConnection, StoryPreviewBrowser, MetricsWatcher, ResourceWatcher, sleep } from 'storycrawler';

import { MainOptions, RunMode } from './types';
import { VariantKey, ScreenshotOptions, StrictScreenshotOptions, Exposed } from '../shared/types';
import { ScreenshotTimeoutError, InvalidCurrentStoryStateError } from './errors';
import {
  createBaseScreenshotOptions,
  mergeScreenshotOptions,
  extractVariantKeys,
  pickupWithVariantKey,
  InvalidVariantKeysReason,
} from '../shared/screenshot-options-helper';
const dd = require('puppeteer/DeviceDescriptors') as { name: string; viewport: Viewport }[];

/**
 *
 * Represents screenshot result.
 *
 * @remarks
 *
 * - If user's screenshot option has `skip: true`,`buffer` gets null and `succeeded` gets `true`
 * - `variantKeysToPush` is set an empty array if the capturing process is set not default variant key. It makes sense for only default variant.
 * - `defaultVariantSuffix` makes sense for only default variant too. It's set non-null value when user specifies multiple viewports.
 *
 **/
interface ScreenshotResult {
  buffer: Buffer | null;
  succeeded: boolean;
  variantKeysToPush: VariantKey[];
  defaultVariantSuffix?: string;
}

/**
 *
 * A worker to capture screenshot images.
 *
 **/
export class CapturingBrowser extends StoryPreviewBrowser {
  private currentStoryRetryCount = 0;
  private viewport?: Viewport;
  private emitter: EventEmitter;
  private readonly processedStories = new Set<string>();
  private baseScreenshotOptions: StrictScreenshotOptions;
  private currentRequestId!: string;
  private currentVariantKey: VariantKey = { isDefault: true, keys: [] };
  private touched = false;
  private resourceWatcher!: ResourceWatcher;

  /**
   *
   * @override
   *
   * @param opt - Options for Storycap.
   * @param mode - Indicates this worker runs as managed mode or simple mode.
   * @param idx - Worker id.
   *
   **/
  constructor(
    protected connection: StorybookConnection,
    protected opt: MainOptions,
    private mode: RunMode,
    idx: number,
  ) {
    super(connection, idx, opt, opt.logger);
    this.emitter = new EventEmitter();
    this.emitter.on('error', e => {
      throw e;
    });
    this.baseScreenshotOptions = createBaseScreenshotOptions(opt);
  }

  /**
   *
   * @override
   *
   **/
  async boot() {
    await super.boot();
    await this.expose();
    await this.addStyles();
    this.resourceWatcher = new ResourceWatcher(this.page).init();
    return this;
  }

  private async addStyles() {
    if (this.opt.disableCssAnimation) {
      await this.page.addStyleTag({ path: path.resolve(__dirname, '../../assets/disable-animation.css') });
    }
  }

  private async expose() {
    const exposed: Exposed = {
      emitCatpture: (opt: ScreenshotOptions, clientStoryKey: string) =>
        this.subscribeScreenshotOptions(opt, clientStoryKey),
      getBaseScreenshotOptions: () => this.baseScreenshotOptions,
      getCurrentVariantKey: () => this.currentVariantKey,
      waitBrowserMetricsStable: () => this.waitBrowserMetricsStable('preEmit'),
    };
    Object.entries(exposed).forEach(([k, f]) => this.page.exposeFunction(k, f));
  }

  private async waitIfTouched() {
    if (!this.touched) return;
    await sleep(this.opt.stateChangeDelay);
  }

  private async resetIfTouched() {
    const story = this.currentStory;
    if (!this.touched || !story) return;
    this.debug('Reset story because page state got dirty in this request.', this.currentRequestId);
    await this.setCurrentStory(story, { forceRerender: true });
    this.touched = false;
    return;
  }

  private async subscribeScreenshotOptions(opt: ScreenshotOptions, clientStoryKey: string) {
    if (this.touched) return;

    if (!this.currentStory) {
      this.emitter.emit('error', new InvalidCurrentStoryStateError());
      return;
    }

    // Sometimes preview window emits options before completion of change story.
    // So asserts story identifiers between this class hold and sent from browser and skips procedure if they're not equal.
    if (this.currentStory.id !== clientStoryKey) {
      this.debug('This options was sent from previous story', this.currentStory.id, clientStoryKey);
      return;
    }

    // Sometimes preview window emits options twice for a story.
    // The second(or more) options should be ignore because we should guarantee just one PNG for each request.
    if (this.processedStories.has(this.currentRequestId)) {
      this.debug(
        'This story was already processed:',
        this.currentRequestId,
        this.currentStory.kind,
        this.currentStory.story,
        this.currentVariantKey,
        JSON.stringify(opt),
      );
      return;
    }
    this.processedStories.add(this.currentRequestId);

    this.debug(
      'Start to process to screenshot story:',
      this.currentRequestId,
      this.currentStory.kind,
      this.currentStory.story,
      this.currentVariantKey,
      JSON.stringify(opt),
    );

    this.emitter.emit('screenshotOptions', opt);
  }

  private async waitForOptionsFromBrowser() {
    return new Promise<ScreenshotOptions | undefined>((resolve, reject) => {
      const id = setTimeout(() => {
        this.emitter.removeAllListeners();
        if (!this.currentStory) {
          reject(new InvalidCurrentStoryStateError());
          return;
        }
        if (this.currentStoryRetryCount < this.opt.captureMaxRetryCount) {
          this.opt.logger.warn(
            `Capture timeout exceeded in ${this.opt.captureTimeout +
              ''} msec. Retry to screenshot this story after this sequence.`,
            this.currentStory.kind,
            this.currentStory.story,
          );
          resolve();
          return;
        }
        reject(new ScreenshotTimeoutError(this.opt.captureTimeout, this.currentStory));
      }, this.opt.captureTimeout);

      const cb = (opt?: ScreenshotOptions) => {
        clearTimeout(id);
        this.emitter.removeAllListeners();
        resolve(opt);
      };

      this.emitter.once('screenshotOptions', cb);
    });
  }

  private async setViewport(opt: StrictScreenshotOptions) {
    if (!this.currentStory) {
      throw new InvalidCurrentStoryStateError();
    }

    let nextViewport: Viewport;

    if (typeof opt.viewport === 'string') {
      if (opt.viewport.match(/^\d+$/)) {
        // For case such as `--viewport "800"`.
        nextViewport = { width: +opt.viewport, height: 600 };
      } else if (opt.viewport.match(/^\d+x\d+$/)) {
        // For case such as `--viewport "800x600"`.
        const [w, h] = opt.viewport.split('x');
        nextViewport = { width: +w, height: +h };
      } else {
        // Handle as Puppeteer device descriptor.
        const hit = dd.find(d => d.name === opt.viewport);
        if (!hit) {
          this.opt.logger.warn(
            `Skip screenshot for ${this.opt.logger.color.yellow(
              JSON.stringify(this.currentStory),
            )} because the viewport ${this.opt.logger.color.magenta(
              opt.viewport,
            )} is not registered in 'puppeteer/DeviceDescriptor'.`,
          );
          return false;
        }
        nextViewport = hit.viewport;
      }
    } else {
      nextViewport = opt.viewport;
    }

    // Sometimes, `page.screenshot` is completed before applying viewport unfortunately.
    // So we compare the current viewport with the next viewport and wait for `opt.viewportDelay` time if they are different.
    if (!this.viewport || JSON.stringify(this.viewport) !== JSON.stringify(nextViewport)) {
      this.debug('Change viewport', JSON.stringify(nextViewport));
      await this.page.setViewport(nextViewport);
      this.viewport = nextViewport;
      if (this.opt.reloadAfterChangeViewport) {
        this.processedStories.delete(this.currentRequestId);
        await Promise.all([this.page.reload(), this.waitForOptionsFromBrowser()]);
      } else {
        await sleep(this.opt.viewportDelay);
      }
    }

    return true;
  }

  private async warnIfTargetElementNotFound(selector: string) {
    const targetElement = await this.page.$(selector);
    if (this.currentStory && !targetElement) {
      this.logger.warn(
        `No matched element for "${this.logger.color.yellow(selector)}" in story "${this.currentStory.id}".`,
      );
    }
  }

  private async setHover(screenshotOptions: StrictScreenshotOptions) {
    if (!screenshotOptions.hover) return;
    await this.warnIfTargetElementNotFound(screenshotOptions.hover);
    await this.page.hover(screenshotOptions.hover);
    this.touched = true;
    return;
  }

  private async setFocus(screenshotOptions: StrictScreenshotOptions) {
    if (!screenshotOptions.focus) return;
    await this.warnIfTargetElementNotFound(screenshotOptions.focus);
    await this.page.focus(screenshotOptions.focus);
    this.touched = true;
    return;
  }

  private async waitForResources(screenshotOptions: StrictScreenshotOptions) {
    if (!screenshotOptions.waitAssets && !screenshotOptions.waitImages) return;
    this.debug('Wait for requested resources resolved', this.resourceWatcher.getRequestedUrls());
    await this.resourceWatcher.waitForRequestsComplete();
  }

  private async waitBrowserMetricsStable(phase: 'preEmit' | 'postEmit') {
    const mw = new MetricsWatcher(this.page, this.opt.metricsWatchRetryCount);
    const checkCountUntillStable = await mw.waitForStable();
    this.debug(`[${phase}] Browser metrics got stable in ${checkCountUntillStable} times checks.`);
    if (checkCountUntillStable >= this.opt.metricsWatchRetryCount) {
      this.opt.logger.warn(
        `Metrics is not stable while ${this.opt.metricsWatchRetryCount} times. ${this.opt.logger.color.yellow(
          JSON.stringify(this.currentStory),
        )}`,
      );
    }
  }

  private logInvalidVariantKeysReason(reason: InvalidVariantKeysReason | null) {
    if (reason) {
      if (reason.type === 'notFound') {
        this.logger.warn(
          `Invalid variants. The variant key '${reason.to}' does not exist(story id: ${this.currentStory!.id}).`,
        );
      } else if (reason.type === 'circular') {
        this.logger.warn(
          `Invalid variants. Reference ${reason.refs.join(' -> ')} is circular(story id: ${this.currentStory!.id}).`,
        );
      }
    }
  }

  /**
   * Captures screenshot as a PNG image buffer from a story.
   *
   * @param requestId - Represents an identifier for the screenshot
   * @param variantKey - Variant identifier for the screenshot
   * @param retryCount - The number which represents how many attempting to capture this story and variant
   *
   * @returns PNG buffer, whether the capturing process is succeeded or not, additional variant keys if they are emitted, and file name suffix for default the default variant.
   *
   * @remarks
   *
   * - Throws an error if `retryCount` is equal to `opt.captureMaxRetryCount` and this capturing process is failed
   *
   **/
  async screenshot(
    requestId: string,
    story: Story,
    variantKey: VariantKey,
    retryCount: number,
  ): Promise<ScreenshotResult> {
    this.currentRequestId = requestId;
    this.currentVariantKey = variantKey;
    this.currentStoryRetryCount = retryCount;
    let emittedScreenshotOptions: ScreenshotOptions | undefined;
    this.resourceWatcher.clear();

    await this.setCurrentStory(story, { forceRerender: true });

    if (this.mode === 'managed') {
      // Screenshot options are emitted form the browser process when managed mode.
      emittedScreenshotOptions = await this.waitForOptionsFromBrowser();
      if (!this.currentStory) {
        throw new InvalidCurrentStoryStateError();
      }
      if (!emittedScreenshotOptions) {
        // End this capturing process as failure of timeout if emitter don't resolve screenshot options.
        return { buffer: null, succeeded: false, variantKeysToPush: [], defaultVariantSuffix: '' };
      }
    } else {
      await sleep(this.opt.delay);
      await this.waitBrowserMetricsStable('preEmit');
      // Use only `baseScreenshotOptions` when simple mode.
      emittedScreenshotOptions = pickupWithVariantKey(this.baseScreenshotOptions, this.currentVariantKey);
    }

    const mergedScreenshotOptions = mergeScreenshotOptions(this.baseScreenshotOptions, emittedScreenshotOptions);

    // Get keys for variants included in the screenshot options in order to queue capturing them after this sequence.
    const [invalidReason, keys] = extractVariantKeys(mergedScreenshotOptions);
    const variantKeysToPush = this.currentVariantKey.isDefault ? keys : [];
    this.logInvalidVariantKeysReason(invalidReason);

    // End this capturing process as success if `skip` set true.
    if (mergedScreenshotOptions.skip) {
      await this.waitForDebugInput();
      return { buffer: null, succeeded: true, variantKeysToPush, defaultVariantSuffix: '' };
    }

    this.touched = false;

    // Change browser's viewport if needed.
    const vpChanged = await this.setViewport(mergedScreenshotOptions);
    // Skip to capture if the viewport option is invalid.
    if (!vpChanged) return { buffer: null, succeeded: true, variantKeysToPush: [], defaultVariantSuffix: '' };

    // Modify elements state.
    await this.setHover(mergedScreenshotOptions);
    await this.setFocus(mergedScreenshotOptions);
    await this.waitIfTouched();

    // Wait until browser main thread gets stable.
    await this.waitForResources(mergedScreenshotOptions);
    await this.waitBrowserMetricsStable('postEmit');

    await this.page.evaluate(
      () => new Promise(res => (window as any).requestIdleCallback(() => res(), { timeout: 3000 })),
    );

    // Get PNG image buffer
    const buffer = await this.page.screenshot({ fullPage: emittedScreenshotOptions.fullPage });

    // We should reset elements state(e.g. focusing, hovering) for future screenshot for this story.
    await this.resetIfTouched();

    await this.waitForDebugInput();

    return {
      buffer,
      succeeded: true,
      variantKeysToPush,
      defaultVariantSuffix: emittedScreenshotOptions.defaultVariantSuffix,
    };
  }
}
