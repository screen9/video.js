/**
 * @file slider.js
 */
import Component from '../component.js';
import * as Dom from '../utils/dom.js';
import {assign} from '../utils/obj';
import {IS_CHROME} from '../utils/browser.js';
import clamp from '../utils/clamp.js';
import keycode from 'keycode';

/**
 * The base functionality for a slider. Can be vertical or horizontal.
 * For instance the volume bar or the seek bar on a video is a slider.
 *
 * @extends Component
 */
class Slider extends Component {

  /**
 * Create an instance of this class
 *
 * @param {Player} player
 *        The `Player` that this class should be attached to.
 *
 * @param {Object} [options]
 *        The key/value store of player options.
 */
  constructor(player, options) {
    super(player, options);

    this.handleMouseDown_ = (e) => this.handleMouseDown(e);
    this.handleMouseUp_ = (e) => this.handleMouseUp(e);
    this.handleKeyDown_ = (e) => this.handleKeyDown(e);
    this.handleClick_ = (e) => this.handleClick(e);
    this.handleMouseMove_ = (e) => this.handleMouseMove(e);
    this.update_ = (e) => this.update(e);

    // Set property names to bar to match with the child Slider class is looking for
    this.bar = this.getChild(this.options_.barName);

    // Set a horizontal or vertical class on the slider depending on the slider type
    this.vertical(!!this.options_.vertical);

    this.enable();
  }

  /**
   * Are controls are currently enabled for this slider or not.
   *
   * @return {boolean}
   *         true if controls are enabled, false otherwise
   */
  enabled() {
    return this.enabled_;
  }

  /**
   * Enable controls for this slider if they are disabled
   */
  enable() {
    if (this.enabled()) {
      return;
    }

    this.on('mousedown', this.handleMouseDown_);
    this.on('touchstart', this.handleMouseDown_);
    this.on('keydown', this.handleKeyDown_);
    this.on('click', this.handleClick_);

    // TODO: deprecated, controlsvisible does not seem to be fired
    this.on(this.player_, 'controlsvisible', this.update);

    if (this.playerEvent) {
      this.on(this.player_, this.playerEvent, this.update);
    }

    this.removeClass('disabled');
    this.setAttribute('tabindex', 0);

    this.enabled_ = true;

    if (this.a11yInputEl_) {
      // The wrapper must stay out of the tab order; focus belongs on the
      // native <input> overlay.
      this.removeAttribute('tabindex');
      this.a11yInputEl_.disabled = false;
    }
  }

  /**
   * Disable controls for this slider if they are enabled
   */
  disable() {
    if (!this.enabled()) {
      return;
    }
    const doc = this.bar.el_.ownerDocument;

    this.off('mousedown', this.handleMouseDown_);
    this.off('touchstart', this.handleMouseDown_);
    this.off('keydown', this.handleKeyDown_);
    this.off('click', this.handleClick_);
    this.off(this.player_, 'controlsvisible', this.update_);
    this.off(doc, 'mousemove', this.handleMouseMove_);
    this.off(doc, 'mouseup', this.handleMouseUp_);
    this.off(doc, 'touchmove', this.handleMouseMove_);
    this.off(doc, 'touchend', this.handleMouseUp_);
    this.removeAttribute('tabindex');

    this.addClass('disabled');

    if (this.playerEvent) {
      this.off(this.player_, this.playerEvent, this.update);
    }
    this.enabled_ = false;

    if (this.a11yInputEl_) {
      this.a11yInputEl_.disabled = true;
    }
  }

  /**
   * Insert a hidden native `<input type="range">` overlay that acts as the
   * accessibility widget for the slider. Used to work around Chrome on
   * Android not reliably emitting adjust actions on ARIA-only sliders
   * (`<div role="slider">`). Subclasses opt-in by calling this method,
   * typically gated by `IS_ANDROID`. Subclasses can override
   * {@link Slider#applyA11yInputValue_} (and optionally
   * {@link Slider#formatA11yValueText_}) to customize how the input's
   * 0–100 percent value maps to a player-side value.
   *
   * Strips role, aria-value*, aria-orientation, aria-label and tabindex from
   * the wrapper so TalkBack focuses the input instead, and marks existing
   * child components `aria-hidden` so they don't pollute the slider's a11y
   * tree.
   *
   * @protected
   */
  setupA11yInput_() {
    // Preserve the existing accessible name set on the wrapper before stripping.
    const ariaLabel = this.el_.getAttribute('aria-label') || this.localize('Slider');

    this.el_.removeAttribute('role');
    this.el_.removeAttribute('aria-valuenow');
    this.el_.removeAttribute('aria-valuemin');
    this.el_.removeAttribute('aria-valuemax');
    this.el_.removeAttribute('aria-valuetext');
    this.el_.removeAttribute('aria-orientation');
    this.el_.removeAttribute('aria-label');
    this.el_.removeAttribute('tabindex');

    this.children().forEach((child) => {
      if (child.el_) {
        child.el_.setAttribute('aria-hidden', 'true');
      }
    });

    this.a11yInputEl_ = Dom.createEl('input', {
      className: 'vjs-slider-a11y-input'
    }, {
      'type': 'range',
      'min': '0',
      'max': '100',
      'step': '1',
      'value': '0',
      'aria-label': ariaLabel
    });

    this.el_.appendChild(this.a11yInputEl_);

    this.on(this.a11yInputEl_, ['focus', 'click', 'dblclick'], (event) => {
      if (event.type !== 'focus') {
        event.preventDefault();
        event.stopPropagation();
      }

      this.syncA11yInput_();
    });

    this.on(this.a11yInputEl_, 'input', () => {
      const newPercent = Number(this.a11yInputEl_.value);
      const currentPercent = this.getProgress() * 100;
      const previousInputPercent = Number(this.a11yInputValue_);

      if (isNaN(newPercent)) {
        return;
      }

      // TalkBack double-tap occasionally snaps the input to 0 even though
      // the user wasn't trying to seek to start. Detect this and rewind.
      if (newPercent === 0 && currentPercent > 1) {
        this.syncA11yInput_();
        return;
      }

      // Native range inputs change in percent steps. Track that value so
      // domain-specific slider steps do not invert a later input direction.
      this.a11yInputValue_ = newPercent;
      this.applyA11yInputValue_(
        newPercent / 100,
        (isNaN(previousInputPercent) ? currentPercent : previousInputPercent) / 100
      );
    });

    this.syncA11yInput_();
  }

  /**
   * Sync the a11y input's value and announced text with current player state.
   * Safe to call even when {@link Slider#setupA11yInput_} was never invoked.
   *
   * @param {number} [percent]
   *        Current progress 0..1. Defaults to {@link Slider#getProgress}.
   * @param {string} [ariaValueText]
   *        Localized text for screen readers. Defaults to subclass-provided
   *        {@link Slider#formatA11yValueText_}.
   *
   * @protected
   */
  syncA11yInput_(percent, ariaValueText) {
    if (!this.a11yInputEl_) {
      return;
    }

    if (percent === undefined) {
      percent = this.getProgress();
    }
    if (ariaValueText === undefined) {
      ariaValueText = this.formatA11yValueText_(percent);
    }

    const value = (percent * 100).toFixed(2);

    this.a11yInputEl_.setAttribute('aria-valuenow', value);
    this.a11yInputEl_.setAttribute('aria-valuetext', ariaValueText);
    this.a11yInputEl_.value = value;
    this.a11yInputValue_ = Number(value);
  }

  /**
   * Apply a value coming from the a11y input (mainly screen reader adjust
   * gestures). Default implementation delegates to {@link Slider#stepForward}
   * / {@link Slider#stepBack} based on direction, so screen-reader adjust
   * matches arrow-key step (e.g. ±5 s for seek bar, ±10 % for volume).
   * Subclasses can override for custom mapping.
   *
   * @param {number} newPct       New slider position, 0..1.
   * @param {number} currentPct   Previous slider position, 0..1.
   *
   * @protected
   */
  applyA11yInputValue_(newPct, currentPct) {
    if (newPct > currentPct) {
      this.stepForward();
    } else if (newPct < currentPct) {
      this.stepBack();
    }
  }

  /**
   * Return the localized text announced by screen readers for the current
   * slider value. Subclasses typically override to read out time, volume,
   * etc. Base implementation returns the percent.
   *
   * @param {number} percent  Current slider position, 0..1.
   * @return {string} Text suitable for `aria-valuetext`.
   *
   * @protected
   */
  formatA11yValueText_(percent) {
    return Math.round(percent * 100) + '%';
  }

  /**
   * Create the `Slider`s DOM element.
   *
   * @param {string} type
   *        Type of element to create.
   *
   * @param {Object} [props={}]
   *        List of properties in Object form.
   *
   * @param {Object} [attributes={}]
   *        list of attributes in Object form.
   *
   * @return {Element}
   *         The element that gets created.
   */
  createEl(type, props = {}, attributes = {}) {
    // Add the slider element class to all sub classes
    props.className = props.className + ' vjs-slider';
    props = assign({
      tabIndex: 0
    }, props);

    attributes = assign({
      'role': 'slider',
      'aria-valuenow': 0,
      'aria-valuemin': 0,
      'aria-valuemax': 100,
      'tabIndex': 0
    }, attributes);

    return super.createEl(type, props, attributes);
  }

  /**
   * Handle `mousedown` or `touchstart` events on the `Slider`.
   *
   * @param {EventTarget~Event} event
   *        `mousedown` or `touchstart` event that triggered this function
   *
   * @listens mousedown
   * @listens touchstart
   * @fires Slider#slideractive
   */
  handleMouseDown(event) {
    const doc = this.bar.el_.ownerDocument;

    if (event.type === 'mousedown') {
      event.preventDefault();
    }
    // Do not call preventDefault() on touchstart in Chrome
    // to avoid console warnings. Use a 'touch-action: none' style
    // instead to prevent unintented scrolling.
    // https://developers.google.com/web/updates/2017/01/scrolling-intervention
    if (event.type === 'touchstart' && !IS_CHROME) {
      event.preventDefault();
    }
    Dom.blockTextSelection();

    this.addClass('vjs-sliding');
    /**
     * Triggered when the slider is in an active state
     *
     * @event Slider#slideractive
     * @type {EventTarget~Event}
     */
    this.trigger('slideractive');

    this.on(doc, 'mousemove', this.handleMouseMove_);
    this.on(doc, 'mouseup', this.handleMouseUp_);
    this.on(doc, 'touchmove', this.handleMouseMove_);
    this.on(doc, 'touchend', this.handleMouseUp_);

    this.handleMouseMove(event, true);
  }

  /**
   * Handle the `mousemove`, `touchmove`, and `mousedown` events on this `Slider`.
   * The `mousemove` and `touchmove` events will only only trigger this function during
   * `mousedown` and `touchstart`. This is due to {@link Slider#handleMouseDown} and
   * {@link Slider#handleMouseUp}.
   *
   * @param {EventTarget~Event} event
   *        `mousedown`, `mousemove`, `touchstart`, or `touchmove` event that triggered
   *        this function
   * @param {boolean} mouseDown this is a flag that should be set to true if `handleMouseMove` is called directly. It allows us to skip things that should not happen if coming from mouse down but should happen on regular mouse move handler. Defaults to false.
   *
   * @listens mousemove
   * @listens touchmove
   */
  handleMouseMove(event) {}

  /**
   * Handle `mouseup` or `touchend` events on the `Slider`.
   *
   * @param {EventTarget~Event} event
   *        `mouseup` or `touchend` event that triggered this function.
   *
   * @listens touchend
   * @listens mouseup
   * @fires Slider#sliderinactive
   */
  handleMouseUp() {
    const doc = this.bar.el_.ownerDocument;

    Dom.unblockTextSelection();

    this.removeClass('vjs-sliding');
    /**
     * Triggered when the slider is no longer in an active state.
     *
     * @event Slider#sliderinactive
     * @type {EventTarget~Event}
     */
    this.trigger('sliderinactive');

    this.off(doc, 'mousemove', this.handleMouseMove_);
    this.off(doc, 'mouseup', this.handleMouseUp_);
    this.off(doc, 'touchmove', this.handleMouseMove_);
    this.off(doc, 'touchend', this.handleMouseUp_);

    this.update();
  }

  /**
   * Update the progress bar of the `Slider`.
   *
   * @return {number}
   *          The percentage of progress the progress bar represents as a
   *          number from 0 to 1.
   */
  update() {
    // In VolumeBar init we have a setTimeout for update that pops and update
    // to the end of the execution stack. The player is destroyed before then
    // update will cause an error
    // If there's no bar...
    if (!this.el_ || !this.bar) {
      return;
    }

    // clamp progress between 0 and 1
    // and only round to four decimal places, as we round to two below
    const progress = this.getProgress();

    if (progress === this.progress_) {
      return progress;
    }

    this.progress_ = progress;

    this.requestNamedAnimationFrame('Slider#update', () => {
      // Set the new bar width or height
      const sizeKey = this.vertical() ? 'height' : 'width';

      // Convert to a percentage for css value
      this.bar.el().style[sizeKey] = (progress * 100).toFixed(2) + '%';
    });

    return progress;
  }

  /**
   * Get the percentage of the bar that should be filled
   * but clamped and rounded.
   *
   * @return {number}
   *         percentage filled that the slider is
   */
  getProgress() {
    return Number(clamp(this.getPercent(), 0, 1).toFixed(4));
  }

  /**
   * Calculate distance for slider
   *
   * @param {EventTarget~Event} event
   *        The event that caused this function to run.
   *
   * @return {number}
   *         The current position of the Slider.
   *         - position.x for vertical `Slider`s
   *         - position.y for horizontal `Slider`s
   */
  calculateDistance(event) {
    const position = Dom.getPointerPosition(this.el_, event);

    if (this.vertical()) {
      return position.y;
    }
    return position.x;
  }

  /**
   * Handle a `keydown` event on the `Slider`. Watches for left, rigth, up, and down
   * arrow keys. This function will only be called when the slider has focus. See
   * {@link Slider#handleFocus} and {@link Slider#handleBlur}.
   *
   * @param {EventTarget~Event} event
   *        the `keydown` event that caused this function to run.
   *
   * @listens keydown
   */
  handleKeyDown(event) {

    // Left and Down Arrows
    if (keycode.isEventKey(event, 'Left') || keycode.isEventKey(event, 'Down')) {
      event.preventDefault();
      event.stopPropagation();
      this.stepBack();

    // Up and Right Arrows
    } else if (keycode.isEventKey(event, 'Right') || keycode.isEventKey(event, 'Up')) {
      event.preventDefault();
      event.stopPropagation();
      this.stepForward();
    } else {

      // Pass keydown handling up for unsupported keys
      super.handleKeyDown(event);
    }
  }

  /**
   * Listener for click events on slider, used to prevent clicks
   *   from bubbling up to parent elements like button menus.
   *
   * @param {Object} event
   *        Event that caused this object to run
   */
  handleClick(event) {
    event.stopPropagation();
    event.preventDefault();
  }

  /**
   * Get/set if slider is horizontal for vertical
   *
   * @param {boolean} [bool]
   *        - true if slider is vertical,
   *        - false is horizontal
   *
   * @return {boolean}
   *         - true if slider is vertical, and getting
   *         - false if the slider is horizontal, and getting
   */
  vertical(bool) {
    if (bool === undefined) {
      return this.vertical_ || false;
    }

    this.vertical_ = !!bool;

    if (this.vertical_) {
      this.addClass('vjs-slider-vertical');
    } else {
      this.addClass('vjs-slider-horizontal');
    }
  }
}

Component.registerComponent('Slider', Slider);
export default Slider;
