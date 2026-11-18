// Hand-written example: traffic light state machine (red 5 s -> green 5 s -> yellow 2 s).
// Pedestrian button (GPIO7, active low) shortens the current green phase.
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/gpio.h"
#include "esp_timer.h"

#define PIN_RED    GPIO_NUM_4
#define PIN_YELLOW GPIO_NUM_5
#define PIN_GREEN  GPIO_NUM_6
#define PIN_BTN    GPIO_NUM_7

typedef enum { RED, GREEN, YELLOW } phase_t;
static const char *NAMES[] = { "RED", "GREEN", "YELLOW" };
static const int DURATION_MS[] = { 5000, 5000, 2000 };

static void show(phase_t p) {
    gpio_set_level(PIN_RED, p == RED);
    gpio_set_level(PIN_YELLOW, p == YELLOW);
    gpio_set_level(PIN_GREEN, p == GREEN);
    printf("phase %s\n", NAMES[p]);
}

void app_main(void) {
    gpio_config_t out = { .pin_bit_mask = (1ULL << PIN_RED) | (1ULL << PIN_YELLOW) | (1ULL << PIN_GREEN), .mode = GPIO_MODE_OUTPUT };
    gpio_config(&out);
    gpio_config_t in = { .pin_bit_mask = 1ULL << PIN_BTN, .mode = GPIO_MODE_INPUT, .pull_up_en = GPIO_PULLUP_ENABLE };
    gpio_config(&in);
    phase_t p = RED;
    show(p);
    int64_t start = esp_timer_get_time();
    while (1) {
        int64_t elapsed_ms = (esp_timer_get_time() - start) / 1000;
        int limit = DURATION_MS[p];
        if (p == GREEN && gpio_get_level(PIN_BTN) == 0 && limit > 1000) {
            printf("pedestrian request\n");
            limit = 1000;
        }
        if (elapsed_ms >= limit) {
            p = (p == RED) ? GREEN : (p == GREEN) ? YELLOW : RED;
            show(p);
            start = esp_timer_get_time();
        }
        vTaskDelay(pdMS_TO_TICKS(10));
    }
}
