// Fixture: LED on GPIO4 follows button on GPIO5 (active low, internal pull-up)
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/gpio.h"
void app_main(void) {
    gpio_reset_pin(GPIO_NUM_4);
    gpio_set_direction(GPIO_NUM_4, GPIO_MODE_OUTPUT);
    gpio_config_t btn = { .pin_bit_mask = 1ULL << GPIO_NUM_5, .mode = GPIO_MODE_INPUT, .pull_up_en = GPIO_PULLUP_ENABLE };
    gpio_config(&btn);
    printf("PLUGAI_FIXTURE button_led\n");
    int last = -1;
    while (1) {
        int pressed = gpio_get_level(GPIO_NUM_5) == 0;
        gpio_set_level(GPIO_NUM_4, pressed);
        if (pressed != last) { printf("button %s\n", pressed ? "pressed" : "released"); last = pressed; }
        vTaskDelay(pdMS_TO_TICKS(5));
    }
}
