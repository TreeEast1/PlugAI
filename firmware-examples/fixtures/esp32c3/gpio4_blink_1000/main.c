// Fixture C: GPIO4 toggles every 500 ms (period 1000 ms)
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/gpio.h"
#define HALF_PERIOD_MS 500
void app_main(void) {
    gpio_reset_pin(GPIO_NUM_4);
    gpio_set_direction(GPIO_NUM_4, GPIO_MODE_OUTPUT);
    printf("PLUGAI_FIXTURE gpio4_blink_1000\n");
    int level = 0;
    while (1) {
        level = !level;
        gpio_set_level(GPIO_NUM_4, level);
        vTaskDelay(pdMS_TO_TICKS(HALF_PERIOD_MS));
    }
}
